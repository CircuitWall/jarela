// Keep server-side validation on the same sanitizer shipped in the unpacked extension.
export {
  collectFormSubmission,
  sanitizeSubmittedFields,
  sanitizeSubmissionUrl,
} from "../browser-extension/lib/form-submission.mjs";
