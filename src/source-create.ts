// What a source create throws (#767), apart from the rest: create-task.ts maps the first to 400 and reads the second's issue for its 502,
// github-create.ts throws them. Node-free and import-free, so neither side imports the other.

/** A name the create cannot resolve (a label, a Status option): thrown before any write, so nothing was created and a retry is safe. */
export class CreateRefusedError extends Error {}

/** A failure once the issue exists: the message names its url, and `issue` lets the caller tell it apart from a safe retry. */
export class IssuePlacementError extends Error {
  constructor(message: string, readonly issue: { number: number; url: string }) {
    super(message);
  }
}
