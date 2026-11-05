export interface SubmittedPreferenceField {
  label: string;
  value: string;
}

export interface FormSubmissionContext {
  site: string;
  url: string;
  title: string;
  submitted_at: string;
  fields: SubmittedPreferenceField[];
}

export function sanitizeSubmittedFields(fields: unknown): SubmittedPreferenceField[];
export function sanitizeSubmissionUrl(rawUrl: string): { site: string; url: string } | null;
export function collectFormSubmission(
  form: HTMLFormElement,
  context: { href: string; title?: string; submittedAt?: string },
): FormSubmissionContext | null;
