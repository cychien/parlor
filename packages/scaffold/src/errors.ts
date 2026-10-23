/** A refusal with a message for the terminal: the bin prints it and exits 1. */
export class CreateError extends Error {
  override readonly name = "CreateError";
}
