import type { DocumentMetadataDto } from "@earendil-works/jot-protocol";
import type { DocumentFrontmatter } from "@earendil-works/jot-renderer";

export function metadataWithFrontmatter(
  metadata: DocumentMetadataDto,
  frontmatter: DocumentFrontmatter | undefined,
  title?: string | undefined,
  knownPeople: DocumentMetadataDto["authors"] = [],
): DocumentMetadataDto {
  const people = [
    ...knownPeople,
    ...metadata.authors,
    ...metadata.reviewers,
    ...metadata.approvers,
  ];
  return {
    ...metadata,
    authors:
      frontmatter?.authors?.map((email) => {
        const known = people.find(
          (person) => person.email.toLocaleLowerCase("en") === email.toLocaleLowerCase("en"),
        );
        return {
          displayName: known?.displayName ?? email,
          email,
          id: email.toLocaleLowerCase("en"),
        };
      }) ?? metadata.authors,
    labels: frontmatter?.labels ?? metadata.labels,
    lifecycleState: frontmatter?.state ?? metadata.lifecycleState,
    sensitivity: frontmatter?.sensitivity ?? metadata.sensitivity,
    title: title ?? metadata.title,
    visibility: frontmatter?.visibility ?? metadata.visibility,
  };
}
