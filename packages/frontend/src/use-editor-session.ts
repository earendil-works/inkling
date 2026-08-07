import { useEffect, useRef, useState } from "react";
import { autocompletion } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter, yamlLanguage } from "@codemirror/lang-yaml";
import { syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { oneDarkTheme } from "@codemirror/theme-one-dark";
import { EditorView, basicSetup } from "codemirror";
import { Effect, Fiber } from "effect";
import { Awareness } from "y-protocols/awareness";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";

import type {
  CommentStateDto,
  DocumentMetadataDto,
  PresenceDto,
} from "@earendil-works/jot-protocol";
import { findJotCodeLanguage, jotSyntaxHighlighter } from "@earendil-works/jot-renderer";

import { makeCollaborationClient } from "./collaboration.ts";
import type { CollaborationClient, ConnectionState } from "./collaboration.ts";
import { commentDecorationsExtension } from "./comments.ts";
import { browserRuntime } from "./effect-runtime.ts";
import {
  frontmatterFieldCompletionDetail,
  makeFrontmatterCompletionSource,
} from "./frontmatter-completion.ts";
import type { FrontmatterVocabulary } from "./frontmatter-completion.ts";
import {
  clearRemotePresence,
  remotePresenceExtension,
  removeRemotePresence,
  setRemotePresence,
} from "./remote-presence.ts";
import { colorFor, randomId } from "./ui.ts";

export interface EditorSession {
  readonly awareness: Awareness;
  readonly body: Y.Text;
  readonly client: CollaborationClient | undefined;
  readonly document: Y.Doc;
  readonly editor: EditorView;
}

interface EditorSessionCallbacks {
  readonly onComments: (comments: CommentStateDto) => void;
  readonly onError: (message: string) => void;
  readonly onMetadata: (metadata: DocumentMetadataDto) => void;
  readonly onParticipants: (participants: readonly PresenceDto[]) => void;
  readonly onPermissions: (permissions: readonly string[]) => void;
  readonly onRevision: (revision: number) => void;
  readonly onState: (state: ConnectionState) => void;
}

interface UseEditorSessionOptions extends EditorSessionCallbacks {
  readonly capabilityToken: string | undefined;
  readonly displayName: string | undefined;
  readonly documentId: string;
  readonly frontmatterVocabulary: FrontmatterVocabulary;
  readonly initialBody: string;
  readonly initiallyEditable: boolean;
  readonly identityId: string | undefined;
  readonly shared: boolean;
}

export interface EditorSessionState {
  readonly body: string;
  readonly editorHostRef: React.RefObject<HTMLDivElement | null>;
  readonly sessionRef: React.RefObject<EditorSession | undefined>;
  readonly sessionRevision: number;
  readonly yRevision: number;
}

export function useEditorSession(options: UseEditorSessionOptions): EditorSessionState {
  const {
    capabilityToken,
    displayName,
    documentId,
    frontmatterVocabulary,
    initialBody,
    initiallyEditable,
    identityId,
    shared,
    ...callbacks
  } = options;
  const callbacksRef = useRef<EditorSessionCallbacks>(callbacks);
  callbacksRef.current = callbacks;
  const editorHostRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<EditorSession | undefined>(undefined);
  const [body, setBody] = useState(initialBody);
  const [yRevision, setYRevision] = useState(0);
  const [sessionRevision, setSessionRevision] = useState(0);

  useEffect(() => {
    const parent = editorHostRef.current;
    if (parent === null || displayName === undefined) return;
    const yDocument = new Y.Doc();
    const yBody = yDocument.getText("body");
    const awareness = new Awareness(yDocument);
    const editable = new Compartment();
    const theme = new Compartment();
    const participantId = randomId("participant");
    const participantColor = colorFor(identityId ?? participantId);
    const participantMap = new Map<string, PresenceDto>();
    const frontmatterCompletion = makeFrontmatterCompletionSource(frontmatterVocabulary);
    let client: CollaborationClient | undefined;
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        extensions: [
          basicSetup,
          syntaxHighlighting(jotSyntaxHighlighter),
          yamlFrontmatter({
            content: markdown({ codeLanguages: findJotCodeLanguage }),
          }),
          yamlLanguage.data.of({ autocomplete: frontmatterCompletion }),
          autocompletion({
            activateOnCompletion: (completion) =>
              completion.detail === frontmatterFieldCompletionDetail,
          }),
          yCollab(yBody, awareness),
          remotePresenceExtension,
          commentDecorationsExtension,
          editable.of(EditorView.editable.of(initiallyEditable)),
          theme.of(document.documentElement.dataset["theme"] === "dark" ? oneDarkTheme : []),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if ((!update.selectionSet && !update.focusChanged) || client === undefined) return;
            const selection = update.view.hasFocus ? update.state.selection.main : undefined;
            browserRuntime.runFork(
              client.sendPresence({
                color: participantColor,
                displayName,
                participantId,
                selectionEnd: selection?.head,
                selectionStart: selection?.anchor,
              }),
            );
          }),
        ],
      }),
    });
    const themeObserver = new MutationObserver(() => {
      editor.dispatch({
        effects: theme.reconfigure(
          document.documentElement.dataset["theme"] === "dark" ? oneDarkTheme : [],
        ),
      });
    });
    themeObserver.observe(document.documentElement, {
      attributeFilter: ["data-theme"],
      attributes: true,
    });
    const updateBody = (): void => {
      setBody(yBody.toString());
      setYRevision((revision) => revision + 1);
    };
    yBody.observe(updateBody);
    sessionRef.current = { awareness, body: yBody, client, document: yDocument, editor };
    setSessionRevision((revision) => revision + 1);

    const collaborationFiber = browserRuntime.runFork(
      makeCollaborationClient(
        documentId,
        yDocument,
        capabilityToken,
        shared ? displayName : undefined,
        {
          onComments: (comments) => callbacksRef.current.onComments(comments),
          onError: (message) => callbacksRef.current.onError(message),
          onMetadata: (metadata) => callbacksRef.current.onMetadata(metadata),
          onPermissions: (permissions) => {
            callbacksRef.current.onPermissions(permissions);
            editor.dispatch({
              effects: editable.reconfigure(
                EditorView.editable.of(permissions.includes("edit-body")),
              ),
            });
          },
          onPresence: (presence) => {
            participantMap.set(presence.participantId, presence);
            editor.dispatch({ effects: setRemotePresence(presence) });
            callbacksRef.current.onParticipants([...participantMap.values()].slice(0, 6));
          },
          onPresenceLeft: (departedParticipantId) => {
            participantMap.delete(departedParticipantId);
            editor.dispatch({ effects: removeRemotePresence(departedParticipantId) });
            callbacksRef.current.onParticipants([...participantMap.values()].slice(0, 6));
          },
          onRevision: (revision) => callbacksRef.current.onRevision(revision),
          onState: (state) => {
            callbacksRef.current.onState(state);
            if (state === "connecting" || state === "disconnected") {
              participantMap.clear();
              editor.dispatch({ effects: clearRemotePresence() });
              callbacksRef.current.onParticipants([]);
            } else if (client !== undefined) {
              const selection = editor.hasFocus ? editor.state.selection.main : undefined;
              browserRuntime.runFork(
                client.sendPresence({
                  color: participantColor,
                  displayName,
                  participantId,
                  selectionEnd: selection?.head,
                  selectionStart: selection?.anchor,
                }),
              );
            }
          },
        },
      ).pipe(
        Effect.tap((created) =>
          Effect.sync(() => {
            client = created;
            sessionRef.current = { awareness, body: yBody, client, document: yDocument, editor };
          }),
        ),
        Effect.catchAll((error) => Effect.sync(() => callbacksRef.current.onError(error.message))),
      ),
    );

    return () => {
      browserRuntime.runFork(Fiber.interrupt(collaborationFiber));
      if (client !== undefined) browserRuntime.runFork(client.close);
      yBody.unobserve(updateBody);
      themeObserver.disconnect();
      editor.destroy();
      awareness.destroy();
      yDocument.destroy();
      sessionRef.current = undefined;
      callbacksRef.current.onParticipants([]);
    };
  }, [
    capabilityToken,
    displayName,
    documentId,
    frontmatterVocabulary,
    identityId,
    initiallyEditable,
    shared,
  ]);

  return { body, editorHostRef, sessionRef, sessionRevision, yRevision };
}
