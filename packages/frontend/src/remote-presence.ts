import { StateEffect, StateField } from "@codemirror/state";
import type { Range, Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";

import type { PresenceDto } from "@earendil-works/inkling-protocol";

interface PositionedPresence {
  readonly anchor: number;
  readonly color: string;
  readonly displayName: string;
  readonly head: number;
  readonly participantId: string;
}

interface RemotePresenceState {
  readonly decorations: DecorationSet;
  readonly participants: ReadonlyMap<string, PositionedPresence>;
}

const setRemotePresenceEffect = StateEffect.define<PresenceDto>();
const removeRemotePresenceEffect = StateEffect.define<string>();
const clearRemotePresenceEffect = StateEffect.define<void>();

class RemoteCursorWidget extends WidgetType {
  readonly presence: PositionedPresence;

  constructor(presence: PositionedPresence) {
    super();
    this.presence = presence;
  }

  override eq(other: RemoteCursorWidget): boolean {
    return (
      other.presence.color === this.presence.color &&
      other.presence.displayName === this.presence.displayName &&
      other.presence.participantId === this.presence.participantId
    );
  }

  override toDOM(): HTMLElement {
    const cursor = document.createElement("span");
    cursor.className = "cm-remote-cursor";
    cursor.dataset["remoteName"] = this.presence.displayName;
    cursor.dataset["remoteParticipant"] = this.presence.participantId;
    cursor.style.setProperty("--remote-color", this.presence.color);
    cursor.append(document.createTextNode("\u2060"));

    const label = document.createElement("span");
    label.className = "cm-remote-cursor__label";
    label.textContent = this.presence.displayName;
    cursor.append(label);
    return cursor;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

const remotePresenceField = StateField.define<RemotePresenceState>({
  create: () => ({ decorations: Decoration.none, participants: new Map() }),
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  update: (current, transaction) => {
    const participants = mapParticipants(current.participants, transaction);
    for (const effect of transaction.effects) {
      if (effect.is(clearRemotePresenceEffect)) {
        participants.clear();
      } else if (effect.is(removeRemotePresenceEffect)) {
        participants.delete(effect.value);
      } else if (effect.is(setRemotePresenceEffect)) {
        const presence = positionPresence(effect.value, transaction.newDoc.length);
        if (presence === undefined) {
          participants.delete(effect.value.participantId);
        } else {
          participants.set(effect.value.participantId, presence);
        }
      }
    }
    return {
      decorations: presenceDecorations(participants),
      participants,
    };
  },
});

export const remotePresenceExtension = remotePresenceField;

export function setRemotePresence(presence: PresenceDto): StateEffect<PresenceDto> {
  return setRemotePresenceEffect.of(presence);
}

export function removeRemotePresence(participantId: string): StateEffect<string> {
  return removeRemotePresenceEffect.of(participantId);
}

export function clearRemotePresence(): StateEffect<void> {
  return clearRemotePresenceEffect.of(undefined);
}

function mapParticipants(
  current: ReadonlyMap<string, PositionedPresence>,
  transaction: Transaction,
): Map<string, PositionedPresence> {
  if (!transaction.docChanged) return new Map(current);
  return new Map(
    [...current].map(([participantId, presence]) => {
      const forward = presence.anchor <= presence.head;
      return [
        participantId,
        {
          ...presence,
          anchor: transaction.changes.mapPos(presence.anchor, forward ? -1 : 1),
          head: transaction.changes.mapPos(presence.head, forward ? 1 : -1),
        },
      ];
    }),
  );
}

function positionPresence(
  presence: PresenceDto,
  documentLength: number,
): PositionedPresence | undefined {
  if (presence.selectionStart === undefined || presence.selectionEnd === undefined) {
    return undefined;
  }
  return {
    anchor: clampPosition(presence.selectionStart, documentLength),
    color: presence.color,
    displayName: presence.displayName,
    head: clampPosition(presence.selectionEnd, documentLength),
    participantId: presence.participantId,
  };
}

function presenceDecorations(participants: ReadonlyMap<string, PositionedPresence>): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const presence of participants.values()) {
    const from = Math.min(presence.anchor, presence.head);
    const to = Math.max(presence.anchor, presence.head);
    const attributes = {
      "data-remote-name": presence.displayName,
      "data-remote-participant": presence.participantId,
      style: `--remote-color: ${presence.color}`,
    };
    if (from !== to) {
      ranges.push(Decoration.mark({ attributes, class: "cm-remote-selection" }).range(from, to));
    }
    ranges.push(
      Decoration.widget({
        side: presence.head >= presence.anchor ? -1 : 1,
        widget: new RemoteCursorWidget(presence),
      }).range(presence.head),
    );
  }
  return Decoration.set(ranges, true);
}

function clampPosition(position: number, documentLength: number): number {
  return Math.max(0, Math.min(documentLength, position));
}
