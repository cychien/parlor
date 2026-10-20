export interface AskField {
  readonly name: string;
  readonly label: string;
  readonly type: "number" | "checkbox" | "text";
  readonly integer: boolean;
  readonly required: boolean;
}

export type AskValues = Record<string, string | number | boolean>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function typeOf(schema: Record<string, unknown>): Pick<AskField, "type" | "integer"> {
  switch (schema.type) {
    case "integer":
      return { type: "number", integer: true };
    case "number":
      return { type: "number", integer: false };
    case "boolean":
      return { type: "checkbox", integer: false };
    default:
      return { type: "text", integer: false };
  }
}

/** One field per property of a form ask's JSON Schema object, in schema order. */
export function askFields(form: Readonly<Record<string, unknown>>): AskField[] {
  const properties = isRecord(form.properties) ? form.properties : {};
  const required = Array.isArray(form.required) ? form.required : [];
  return Object.entries(properties).map(([name, property]) => {
    const schema = isRecord(property) ? property : {};
    return {
      name,
      label: typeof schema.title === "string" ? schema.title : name,
      required: required.includes(name),
      ...typeOf(schema),
    };
  });
}

/** What a filled form answers: numbers as numbers, checkboxes as booleans, blanks left out. */
export function askValues(fields: readonly AskField[], form: HTMLFormElement): AskValues {
  const values: AskValues = {};
  for (const field of fields) {
    const input = form.elements.namedItem(field.name);
    if (!(input instanceof HTMLInputElement)) continue;
    if (field.type === "checkbox") values[field.name] = input.checked;
    else if (input.value === "") continue;
    else if (field.type === "number") values[field.name] = Number(input.value);
    else values[field.name] = input.value;
  }
  return values;
}
