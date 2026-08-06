import { useEffect, useRef, useState } from "react";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
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

import { makeCollaborationClient } from "./collaboration.ts";
import type { CollaborationClient, ConnectionState } from "./collaboration.ts";
import { commentDecorationsExtension } from "./comments.ts";
import { browserRuntime } from "./effect-runtime.ts";
import { colorFor, guestName, randomId } from "./ui.ts";

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
  readonly onState: (state: ConnectionState) => void;
}

interface UseEditorSessionOptions extends EditorSessionCallbacks {
  readonly capabilityToken: string | undefined;
  readonly documentId: string;
  readonly initialBody: string;
  readonly initiallyEditable: boolean;
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
  const { capabilityToken, documentId, initialBody, initiallyEditable, shared, ...callbacks } =
    options;
  const callbacksRef = useRef<EditorSessionCallbacks>(callbacks);
  callbacksRef.current = callbacks;
  const editorHostRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<EditorSession | undefined>(undefined);
  const [body, setBody] = useState(initialBody);
  const [yRevision, setYRevision] = useState(0);
  const [sessionRevision, setSessionRevision] = useState(0);

  useEffect(() => {
    const parent = editorHostRef.current;
    if (parent === null) return;
    const yDocument = new Y.Doc();
    const yBody = yDocument.getText("body");
    const awareness = new Awareness(yDocument);
    const editable = new Compartment();
    const theme = new Compartment();
    const participantId = randomId("participant");
    const participantColor = colorFor(participantId);
    const participantMap = new Map<string, PresenceDto>();
    let client: CollaborationClient | undefined;
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        extensions: [
          basicSetup,
          markdown(),
          yCollab(yBody, awareness),
          commentDecorationsExtension,
          editable.of(EditorView.editable.of(initiallyEditable)),
          theme.of(document.documentElement.dataset["theme"] === "dark" ? oneDark : []),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (!update.selectionSet || client === undefined) return;
            const selection = update.state.selection.main;
            browserRuntime.runFork(
              client.sendPresence({
                color: participantColor,
                displayName: shared ? guestName() : "Owner",
                participantId,
                selectionEnd: selection.to,
                selectionStart: selection.from,
              }),
            );
          }),
        ],
      }),
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
        shared ? guestName() : undefined,
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
            callbacksRef.current.onParticipants([...participantMap.values()].slice(0, 6));
          },
          onState: (state) => callbacksRef.current.onState(state),
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
      editor.destroy();
      awareness.destroy();
      yDocument.destroy();
      sessionRef.current = undefined;
      callbacksRef.current.onParticipants([]);
    };
  }, [capabilityToken, documentId, initiallyEditable, shared]);

  return { body, editorHostRef, sessionRef, sessionRevision, yRevision };
}
