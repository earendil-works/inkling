interface HelpTopic {
  readonly arguments?: readonly (readonly [name: string, description: string])[];
  readonly commands?: readonly (readonly [name: string, description: string])[];
  readonly description: string;
  readonly notes?: readonly string[];
  readonly options?: readonly (readonly [flags: string, description: string])[];
  readonly usage: readonly string[];
}

const helpTopics: Readonly<Record<string, HelpTopic>> = {
  "": {
    commands: [
      ["serve", "Start a local Inkling server."],
      ["instance", "Manage named API-key instances."],
      ["share-instance", "Register a shared document URL."],
      ["use", "Select the active instance."],
      ["list", "List workspace documents."],
      ["search", "Search workspace documents."],
      ["read", "Read a working document and its comments."],
      ["create", "Create a note or RFC."],
      ["edit", "Replace unique text in a document."],
      ["replace", "Replace a complete Markdown body."],
      ["metadata", "Update a structured metadata field."],
      ["delete", "Move a document to Trash or permanently delete it."],
      ["trash / undelete", "List or restore deleted documents."],
      ["publish / unpublish", "Manage the published revision."],
      ["share", "Inspect or change capability sharing."],
      ["attachment", "List, upload, or download attachments."],
      ["comment / reply", "Create comment threads and replies."],
      ["comment-edit / comment-delete", "Edit or delete comment messages."],
      ["thread-delete", "Delete a complete comment thread."],
      ["resolve / reopen", "Change comment thread state."],
      ["import-rfc / import-jot", "Import legacy documents."],
      ["backup / restore", "Export or restore a workspace backup."],
      ["verify / repair", "Verify storage or rebuild the catalog."],
    ],
    description: "Multiplayer Markdown for people and agents.",
    notes: [
      "Run `inkling <command> --help` for command-specific help.",
      "INKLING_INSTANCE overrides the active instance. INKLING_AUTHOR names guest comments.",
    ],
    usage: ["inkling <command> [options]", "inkling help [command [subcommand]]"],
  },
  serve: {
    description: "Start a local Inkling HTTP and WebSocket server.",
    options: [
      ["--port PORT", "Listen on PORT (default: PORT or 8787)."],
      ["--data-dir PATH", "Store durable data at PATH (default: INKLING_DATA_DIR or .inkling)."],
    ],
    usage: ["inkling serve [--port PORT] [--data-dir PATH]"],
  },
  instance: {
    commands: [
      ["add NAME URL API_KEY", "Register or replace a named authenticated instance."],
      ["remove NAME", "Remove a named instance."],
      ["list", "List configured instances and mark the active one."],
    ],
    description: "Manage named authenticated Inkling instances.",
    usage: ["inkling instance <command>"],
  },
  "instance add": {
    arguments: [
      ["NAME", "Local name for the instance."],
      ["URL", "HTTP or HTTPS base URL of the Inkling deployment."],
      ["API_KEY", "Personal API key created from the browser account menu."],
    ],
    description: "Register or replace a named authenticated Inkling instance.",
    notes: ["The API key is stored in Inkling's user-only configuration file."],
    usage: ["inkling instance add NAME URL API_KEY"],
  },
  "instance remove": {
    arguments: [["NAME", "Configured instance name to remove."]],
    description: "Remove a named instance from the local configuration.",
    usage: ["inkling instance remove NAME"],
  },
  "instance list": {
    description: "List configured instances. The active instance is marked with an asterisk.",
    usage: ["inkling instance list"],
  },
  "share-instance": {
    arguments: [
      ["NAME", "Local name for the shared document."],
      ["CAPABILITY_URL", "Full Inkling /share/ URL, including its capability token."],
    ],
    description: "Register a capability-shared document as a named instance.",
    usage: ["inkling share-instance NAME CAPABILITY_URL"],
  },
  use: {
    arguments: [["NAME", "Configured instance name to make active."]],
    description: "Select the default instance used by API commands.",
    usage: ["inkling use NAME"],
  },
  list: {
    description: "List documents visible to the selected instance.",
    usage: ["inkling list"],
  },
  search: {
    arguments: [["QUERY", "Search expression. Quote it when it contains shell metacharacters."]],
    description: "Search documents visible to the selected instance.",
    usage: ["inkling search QUERY"],
  },
  "import-rfc": {
    arguments: [["MARKDOWN", "Path to an Earendil RFC Markdown file."]],
    description: "Import an Earendil RFC and its referenced local attachments.",
    options: [
      ["--people PEOPLE_JSON", "Use a JSON people directory while normalizing identities."],
      ["--publish", "Publish the imported revision even when it is not public."],
    ],
    usage: ["inkling import-rfc MARKDOWN [--people PEOPLE_JSON] [--publish]"],
  },
  "import-jot": {
    arguments: [
      ["MARKDOWN", "Path to a legacy Jot Markdown file."],
      ["SIDECAR_JSON", "Path to its metadata sidecar JSON file."],
    ],
    description: "Import a legacy Jot document and its metadata.",
    options: [["--publish", "Publish the imported revision even when it is not public."]],
    usage: ["inkling import-jot MARKDOWN SIDECAR_JSON [--publish]"],
  },
  backup: {
    arguments: [["DESTINATION", "Path where the binary backup archive will be written."]],
    description: "Export a portable workspace backup from the selected instance.",
    usage: ["inkling backup DESTINATION"],
  },
  restore: {
    arguments: [["BACKUP", "Path to a binary Inkling backup archive."]],
    description: "Restore and verify a workspace backup on the selected instance.",
    usage: ["inkling restore BACKUP"],
  },
  verify: {
    description: "Verify the selected workspace's durable objects and projections.",
    usage: ["inkling verify"],
  },
  repair: {
    description: "Rebuild the selected workspace catalog from document checkpoints.",
    usage: ["inkling repair"],
  },
  read: {
    arguments: [["DOCUMENT", "Document ID. Omit it when using a shared-document instance."]],
    description: "Read a document working head, metadata, and comment identifiers.",
    options: [["--lines START:END", "Print only the inclusive one-based line range."]],
    usage: ["inkling read [DOCUMENT] [--lines START:END]"],
  },
  create: {
    arguments: [["TITLE", "Title used for the document's initial top-level heading."]],
    description: "Create a new note or numbered RFC.",
    notes: [
      "Without --body, Markdown is read from standard input; a terminal supplies an empty body.",
    ],
    options: [
      ["--rfc", "Allocate the next RFC number."],
      ["--body MARKDOWN", "Use MARKDOWN instead of reading standard input."],
    ],
    usage: ["inkling create TITLE [--rfc] [--body MARKDOWN]"],
  },
  edit: {
    arguments: [
      ["DOCUMENT", "Document ID. Omit it when using a shared-document instance."],
      ["OLD_TEXT", "Existing text that must occur exactly once."],
      ["NEW_TEXT", "Replacement text."],
    ],
    description: "Safely replace one unique text occurrence in the working document.",
    usage: ["inkling edit [DOCUMENT] OLD_TEXT NEW_TEXT"],
  },
  replace: {
    arguments: [
      ["DOCUMENT", "Document ID. Omit it when using a shared-document instance."],
      ["MARKDOWN_PATH", "Markdown file path, or - to read standard input."],
    ],
    description: "Replace the complete collaborative Markdown body.",
    usage: ["inkling replace [DOCUMENT] MARKDOWN_PATH|-"],
  },
  metadata: {
    arguments: [
      ["DOCUMENT", "Document ID. Omit it when using a shared-document instance."],
      ["FIELD", "Structured metadata field to update."],
      ["VALUE", "New field value."],
    ],
    description: "Update one structured metadata field at the current revision.",
    notes: [
      "Fields: authors, reviewers, approvers, labels, relatedDocuments, targetDecisionDate, legacySourceUrl, lifecycleState, visibility.",
      "People use `Name <email>` entries separated by commas. Use `none` to clear optional scalar fields.",
    ],
    usage: ["inkling metadata [DOCUMENT] FIELD VALUE"],
  },
  delete: {
    arguments: [["DOCUMENT", "Document ID. Omit it when using a shared-document instance."]],
    description: "Move a document to Trash, or permanently delete one already in Trash.",
    notes: ["Documents in Trash are permanently deleted automatically after 30 days."],
    options: [["--hard", "Permanently delete a document already in Trash."]],
    usage: ["inkling delete [DOCUMENT] [--hard]"],
  },
  trash: {
    description: "List documents in Trash and their deletion timestamps.",
    usage: ["inkling trash"],
  },
  undelete: documentCommand("Restore a document from Trash.", "undelete"),
  publish: documentCommand("Publish the current working revision.", "publish"),
  unpublish: documentCommand("Remove the document's published revision from readers.", "unpublish"),
  share: {
    arguments: [
      ["DOCUMENT", "Document ID. Omit it when using a shared-document instance."],
      ["ACCESS", "One of view, comment, or edit. Omit to list links; disabled deletes all."],
    ],
    description: "List, create, or delete a document's capability links.",
    usage: ["inkling share [DOCUMENT] [disabled|view|comment|edit]"],
  },
  attachment: {
    commands: [
      ["list [DOCUMENT]", "List document attachments."],
      ["upload FILE [DOCUMENT]", "Upload an immutable attachment."],
      ["download ATTACHMENT_ID DESTINATION [DOCUMENT]", "Download attachment bytes."],
    ],
    description: "Manage document attachments.",
    usage: ["inkling attachment <command>"],
  },
  "attachment list": {
    arguments: [["DOCUMENT", "Document ID. Omit it when using a shared-document instance."]],
    description: "List a document's attachments with IDs, sizes, media types, and filenames.",
    usage: ["inkling attachment list [DOCUMENT]"],
  },
  "attachment upload": {
    arguments: [
      ["FILE", "Local file to upload."],
      ["DOCUMENT", "Document ID. Omit it when using a shared-document instance."],
    ],
    description: "Upload an immutable attachment to a document.",
    options: [["--type MEDIA_TYPE", "Override the media type inferred from the filename."]],
    usage: ["inkling attachment upload FILE [DOCUMENT] [--type MEDIA_TYPE]"],
  },
  "attachment download": {
    arguments: [
      ["ATTACHMENT_ID", "Attachment identifier returned by list or upload."],
      ["DESTINATION", "Local path where the bytes will be written."],
      ["DOCUMENT", "Document ID. Omit it when using a shared-document instance."],
    ],
    description: "Download an attachment from a document.",
    usage: ["inkling attachment download ATTACHMENT_ID DESTINATION [DOCUMENT]"],
  },
  comment: {
    arguments: [
      ["DOCUMENT", "Document ID. Omit it when using a shared-document instance."],
      ["START_OFFSET", "Zero-based inclusive source character offset."],
      ["END_OFFSET", "Zero-based exclusive source character offset."],
      ["BODY", "Root comment message."],
    ],
    description: "Create a comment thread anchored to a Markdown source range.",
    usage: ["inkling comment [DOCUMENT] START_OFFSET END_OFFSET BODY"],
  },
  reply: {
    arguments: [
      ["DOCUMENT", "Document ID. Omit it when using a shared-document instance."],
      ["THREAD_ID", "Thread identifier shown by read."],
      ["PARENT_MESSAGE_ID", "Message identifier to reply to."],
      ["BODY", "Reply message."],
    ],
    description: "Reply to a message in an existing comment thread.",
    usage: ["inkling reply [DOCUMENT] THREAD_ID PARENT_MESSAGE_ID BODY"],
  },
  "comment-edit": commentMessageCommand("Edit an existing comment message.", true),
  "comment-delete": commentMessageCommand("Delete an existing comment message.", false),
  "thread-delete": {
    arguments: [
      ["DOCUMENT", "Document ID. Omit it when using a shared-document instance."],
      ["THREAD_ID", "Thread identifier shown by read."],
    ],
    description: "Delete a complete comment thread.",
    usage: ["inkling thread-delete [DOCUMENT] THREAD_ID"],
  },
  resolve: threadStateCommand("Mark a comment thread as resolved.", "resolve"),
  reopen: threadStateCommand("Reopen a resolved comment thread.", "reopen"),
};

const nestedCommands = new Set(["attachment", "instance"]);

export interface HelpRequest {
  readonly topic: string;
}

export function requestedHelp(arguments_: readonly string[]): HelpRequest | undefined {
  if (arguments_.length === 0) return { topic: "" };
  const command = arguments_[0];
  if (command === "help") return { topic: helpTopic(arguments_.slice(1)) };
  if (command === "--help" || command === "-h") return { topic: "" };
  const helpIndex = arguments_.findIndex((argument) => argument === "--help" || argument === "-h");
  return helpIndex === -1 ? undefined : { topic: helpTopic(arguments_.slice(0, helpIndex)) };
}

export function renderHelp(topic: string): string | undefined {
  const help = helpTopics[topic];
  if (help === undefined) return undefined;
  const output = [topic === "" ? `Inkling — ${help.description}` : help.description, "", "Usage:"];
  output.push(...help.usage.map((usage) => `  ${usage}`));
  appendRows(output, "Commands", help.commands);
  appendRows(output, "Arguments", help.arguments);
  appendRows(output, "Options", [
    ...(help.options ?? []),
    ["-h, --help", "Show this help message."],
  ]);
  if (help.notes !== undefined && help.notes.length > 0) {
    output.push("", ...help.notes);
  }
  return `${output.join("\n")}\n`;
}

export const helpTopicNames: readonly string[] = Object.keys(helpTopics);

function documentCommand(description: string, command: string): HelpTopic {
  return {
    arguments: [["DOCUMENT", "Document ID. Omit it when using a shared-document instance."]],
    description,
    usage: [`inkling ${command} [DOCUMENT]`],
  };
}

function commentMessageCommand(description: string, includesBody: boolean): HelpTopic {
  const command = includesBody ? "comment-edit" : "comment-delete";
  return {
    arguments: [
      ["DOCUMENT", "Document ID. Omit it when using a shared-document instance."],
      ["THREAD_ID", "Thread identifier shown by read."],
      ["MESSAGE_ID", "Message identifier shown by read."],
      ...(includesBody ? ([["BODY", "Replacement message body."]] as const) : []),
    ],
    description,
    usage: [`inkling ${command} [DOCUMENT] THREAD_ID MESSAGE_ID${includesBody ? " BODY" : ""}`],
  };
}

function threadStateCommand(description: string, command: string): HelpTopic {
  return {
    arguments: [
      ["DOCUMENT", "Document ID. Omit it when using a shared-document instance."],
      ["THREAD_ID", "Thread identifier shown by read."],
    ],
    description,
    usage: [`inkling ${command} [DOCUMENT] THREAD_ID`],
  };
}

function helpTopic(arguments_: readonly string[]): string {
  const command = arguments_.find((argument) => !argument.startsWith("-"));
  if (command === undefined) return "";
  const commandIndex = arguments_.indexOf(command);
  const subcommand = arguments_
    .slice(commandIndex + 1)
    .find((argument) => !argument.startsWith("-"));
  return nestedCommands.has(command) && subcommand !== undefined
    ? `${command} ${subcommand}`
    : command;
}

function appendRows(
  output: string[],
  heading: string,
  rows: readonly (readonly [name: string, description: string])[] | undefined,
): void {
  if (rows === undefined || rows.length === 0) return;
  const width = Math.max(...rows.map(([name]) => name.length));
  output.push("", `${heading}:`);
  output.push(...rows.map(([name, description]) => `  ${name.padEnd(width)}  ${description}`));
}
