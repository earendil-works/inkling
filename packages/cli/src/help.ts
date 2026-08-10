interface HelpTopic {
  readonly arguments?: readonly (readonly [name: string, description: string])[];
  readonly commands?: readonly (readonly [name: string, description: string])[];
  readonly description: string;
  readonly notes?: readonly string[];
  readonly options?: readonly (readonly [flags: string, description: string])[];
  readonly usage: readonly string[];
}

const workspaceArgument = [
  [
    "WORKSPACE",
    "Configured domain and optional port, such as inkling.example.com or localhost:8787.",
  ],
] as const;

const documentTargetArguments = [
  ["WORKSPACE_OR_URL", "Complete Inkling document URL, or a configured DOMAIN[:PORT]."],
  ["DOCUMENT_ID", "Document ID; required after a workspace and omitted after a URL."],
] as const;

const helpTopics: Readonly<Record<string, HelpTopic>> = {
  "": {
    commands: [
      ["serve", "Start a local Inkling server."],
      ["workspace", "Manage URL-derived workspace connections."],
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
      "Complete document URLs imply their workspace. Document IDs require DOMAIN[:PORT].",
      "INKLING_AUTHOR names guest comments.",
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
  workspace: {
    commands: [
      ["add URL API_KEY", "Connect or replace a workspace derived from URL."],
      ["remove DOMAIN[:PORT]", "Remove a workspace connection."],
      ["list", "List configured workspace domains and base URLs."],
    ],
    description: "Manage authenticated Inkling workspace connections.",
    usage: ["inkling workspace <command>"],
  },
  "workspace add": {
    arguments: [
      ["URL", "HTTP or HTTPS origin of the Inkling deployment."],
      ["API_KEY", "Personal API key created from the browser account menu."],
    ],
    description: "Connect a workspace using its domain and optional port as its local identifier.",
    notes: ["The API key is stored in Inkling's user-only configuration file."],
    usage: ["inkling workspace add URL API_KEY"],
  },
  "workspace remove": {
    arguments: [["DOMAIN[:PORT]", "Configured workspace domain and optional port."]],
    description: "Remove a workspace connection from the local configuration.",
    usage: ["inkling workspace remove DOMAIN[:PORT]"],
  },
  "workspace list": {
    description: "List configured workspace domains and their base URLs.",
    usage: ["inkling workspace list"],
  },
  list: {
    arguments: workspaceArgument,
    description: "List documents visible to a workspace.",
    usage: ["inkling list WORKSPACE"],
  },
  search: {
    arguments: [
      ...workspaceArgument,
      ["QUERY", "Search expression. Quote it when it contains shell metacharacters."],
    ],
    description: "Search documents visible to a workspace.",
    usage: ["inkling search WORKSPACE QUERY"],
  },
  "import-rfc": {
    arguments: [...workspaceArgument, ["MARKDOWN", "Path to an Earendil RFC Markdown file."]],
    description: "Import an Earendil RFC and its referenced local attachments.",
    options: [
      ["--people PEOPLE_JSON", "Use a JSON people directory while normalizing identities."],
      ["--publish", "Publish the imported revision even when it is not public."],
    ],
    usage: ["inkling import-rfc WORKSPACE MARKDOWN [--people PEOPLE_JSON] [--publish]"],
  },
  "import-jot": {
    arguments: [
      ...workspaceArgument,
      ["MARKDOWN", "Path to a legacy Jot Markdown file."],
      ["SIDECAR_JSON", "Path to its metadata sidecar JSON file."],
    ],
    description: "Import a legacy Jot document and its metadata.",
    options: [["--publish", "Publish the imported revision even when it is not public."]],
    usage: ["inkling import-jot WORKSPACE MARKDOWN SIDECAR_JSON [--publish]"],
  },
  backup: {
    arguments: [
      ...workspaceArgument,
      ["DESTINATION", "Path where the binary backup archive will be written."],
    ],
    description: "Export a portable workspace backup.",
    usage: ["inkling backup WORKSPACE DESTINATION"],
  },
  restore: {
    arguments: [...workspaceArgument, ["BACKUP", "Path to a binary Inkling backup archive."]],
    description: "Restore and verify a workspace backup.",
    usage: ["inkling restore WORKSPACE BACKUP"],
  },
  verify: {
    arguments: workspaceArgument,
    description: "Verify a workspace's durable objects and projections.",
    usage: ["inkling verify WORKSPACE"],
  },
  repair: {
    arguments: workspaceArgument,
    description: "Rebuild a workspace catalog from document checkpoints.",
    usage: ["inkling repair WORKSPACE"],
  },
  read: {
    arguments: documentTargetArguments,
    description: "Read a document, its metadata, and comment identifiers.",
    notes: [
      "A reader URL returns its published revision; an /edit URL returns the working head.",
      "Capability URLs are used directly and do not need a workspace connection.",
    ],
    options: [["--lines START:END", "Print only the inclusive one-based line range."]],
    usage: [
      "inkling read URL [--lines START:END]",
      "inkling read WORKSPACE DOCUMENT_ID [--lines START:END]",
    ],
  },
  create: {
    arguments: [
      ...workspaceArgument,
      ["TITLE", "Title used for the document's initial top-level heading."],
    ],
    description: "Create a new note or numbered RFC.",
    notes: [
      "Without --body, Markdown is read from standard input; a terminal supplies an empty body.",
    ],
    options: [
      ["--rfc", "Allocate the next RFC number."],
      ["--body MARKDOWN", "Use MARKDOWN instead of reading standard input."],
    ],
    usage: ["inkling create WORKSPACE TITLE [--rfc] [--body MARKDOWN]"],
  },
  edit: {
    arguments: [
      ...documentTargetArguments,
      ["OLD_TEXT", "Existing text that must occur exactly once."],
      ["NEW_TEXT", "Replacement text."],
    ],
    description: "Safely replace one unique text occurrence in the working document.",
    usage: [
      "inkling edit URL OLD_TEXT NEW_TEXT",
      "inkling edit WORKSPACE DOCUMENT_ID OLD_TEXT NEW_TEXT",
    ],
  },
  replace: {
    arguments: [
      ...documentTargetArguments,
      ["MARKDOWN_PATH", "Markdown file path, or - to read standard input."],
    ],
    description: "Replace the complete collaborative Markdown body.",
    usage: [
      "inkling replace URL MARKDOWN_PATH|-",
      "inkling replace WORKSPACE DOCUMENT_ID MARKDOWN_PATH|-",
    ],
  },
  metadata: {
    arguments: [
      ...documentTargetArguments,
      ["FIELD", "Structured metadata field to update."],
      ["VALUE", "New field value."],
    ],
    description: "Update one structured metadata field at the current revision.",
    notes: [
      "Fields: authors, reviewers, approvers, labels, relatedDocuments, targetDecisionDate, legacySourceUrl, lifecycleState, visibility.",
      "People use `Name <email>` entries separated by commas. Use `none` to clear optional scalar fields.",
    ],
    usage: [
      "inkling metadata URL FIELD VALUE",
      "inkling metadata WORKSPACE DOCUMENT_ID FIELD VALUE",
    ],
  },
  delete: {
    arguments: documentTargetArguments,
    description: "Move a document to Trash, or permanently delete one already in Trash.",
    notes: ["Documents in Trash are permanently deleted automatically after 30 days."],
    options: [["--hard", "Permanently delete a document already in Trash."]],
    usage: ["inkling delete URL [--hard]", "inkling delete WORKSPACE DOCUMENT_ID [--hard]"],
  },
  trash: {
    arguments: workspaceArgument,
    description: "List documents in Trash and their deletion timestamps.",
    usage: ["inkling trash WORKSPACE"],
  },
  undelete: documentCommand("Restore a document from Trash.", "undelete"),
  publish: documentCommand("Publish the current working revision.", "publish"),
  unpublish: documentCommand("Remove the document's published revision from readers.", "unpublish"),
  share: {
    arguments: [
      ...documentTargetArguments,
      ["ACCESS", "One of view, comment, or edit. Omit to list links; disabled deletes all."],
    ],
    description: "List, create, or delete a document's capability links.",
    usage: [
      "inkling share URL [disabled|view|comment|edit]",
      "inkling share WORKSPACE DOCUMENT_ID [disabled|view|comment|edit]",
    ],
  },
  attachment: {
    commands: [
      ["list TARGET", "List document attachments."],
      ["upload TARGET FILE", "Upload an immutable attachment."],
      ["download TARGET ATTACHMENT_ID DESTINATION", "Download attachment bytes."],
    ],
    description: "Manage document attachments.",
    usage: ["inkling attachment <command>"],
  },
  "attachment list": {
    arguments: documentTargetArguments,
    description: "List a document's attachments with IDs, sizes, media types, and filenames.",
    usage: ["inkling attachment list URL", "inkling attachment list WORKSPACE DOCUMENT_ID"],
  },
  "attachment upload": {
    arguments: [...documentTargetArguments, ["FILE", "Local file to upload."]],
    description: "Upload an immutable attachment to a document.",
    options: [["--type MEDIA_TYPE", "Override the media type inferred from the filename."]],
    usage: [
      "inkling attachment upload URL FILE [--type MEDIA_TYPE]",
      "inkling attachment upload WORKSPACE DOCUMENT_ID FILE [--type MEDIA_TYPE]",
    ],
  },
  "attachment download": {
    arguments: [
      ...documentTargetArguments,
      ["ATTACHMENT_ID", "Attachment identifier returned by list or upload."],
      ["DESTINATION", "Local path where the bytes will be written."],
    ],
    description: "Download an attachment from a document.",
    usage: [
      "inkling attachment download URL ATTACHMENT_ID DESTINATION",
      "inkling attachment download WORKSPACE DOCUMENT_ID ATTACHMENT_ID DESTINATION",
    ],
  },
  comment: {
    arguments: [
      ...documentTargetArguments,
      ["START_OFFSET", "Zero-based inclusive source character offset."],
      ["END_OFFSET", "Zero-based exclusive source character offset."],
      ["BODY", "Root comment message."],
    ],
    description: "Create a comment thread anchored to a Markdown source range.",
    usage: [
      "inkling comment URL START_OFFSET END_OFFSET BODY",
      "inkling comment WORKSPACE DOCUMENT_ID START_OFFSET END_OFFSET BODY",
    ],
  },
  reply: {
    arguments: [
      ...documentTargetArguments,
      ["THREAD_ID", "Thread identifier shown by read."],
      ["PARENT_MESSAGE_ID", "Message identifier to reply to."],
      ["BODY", "Reply message."],
    ],
    description: "Reply to a message in an existing comment thread.",
    usage: [
      "inkling reply URL THREAD_ID PARENT_MESSAGE_ID BODY",
      "inkling reply WORKSPACE DOCUMENT_ID THREAD_ID PARENT_MESSAGE_ID BODY",
    ],
  },
  "comment-edit": commentMessageCommand("Edit an existing comment message.", true),
  "comment-delete": commentMessageCommand("Delete an existing comment message.", false),
  "thread-delete": {
    arguments: [...documentTargetArguments, ["THREAD_ID", "Thread identifier shown by read."]],
    description: "Delete a complete comment thread.",
    usage: [
      "inkling thread-delete URL THREAD_ID",
      "inkling thread-delete WORKSPACE DOCUMENT_ID THREAD_ID",
    ],
  },
  resolve: threadStateCommand("Mark a comment thread as resolved.", "resolve"),
  reopen: threadStateCommand("Reopen a resolved comment thread.", "reopen"),
};

const nestedCommands = new Set(["attachment", "workspace"]);

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
    arguments: documentTargetArguments,
    description,
    usage: [`inkling ${command} URL`, `inkling ${command} WORKSPACE DOCUMENT_ID`],
  };
}

function commentMessageCommand(description: string, includesBody: boolean): HelpTopic {
  const command = includesBody ? "comment-edit" : "comment-delete";
  return {
    arguments: [
      ...documentTargetArguments,
      ["THREAD_ID", "Thread identifier shown by read."],
      ["MESSAGE_ID", "Message identifier shown by read."],
      ...(includesBody ? ([["BODY", "Replacement message body."]] as const) : []),
    ],
    description,
    usage: [
      `inkling ${command} URL THREAD_ID MESSAGE_ID${includesBody ? " BODY" : ""}`,
      `inkling ${command} WORKSPACE DOCUMENT_ID THREAD_ID MESSAGE_ID${includesBody ? " BODY" : ""}`,
    ],
  };
}

function threadStateCommand(description: string, command: string): HelpTopic {
  return {
    arguments: [...documentTargetArguments, ["THREAD_ID", "Thread identifier shown by read."]],
    description,
    usage: [
      `inkling ${command} URL THREAD_ID`,
      `inkling ${command} WORKSPACE DOCUMENT_ID THREAD_ID`,
    ],
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
