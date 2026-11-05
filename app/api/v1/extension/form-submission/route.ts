import { handleFormSubmission, handleFormSubmissionOptions } from "@/lib/api/form-submission";

/**
 * @public-internal — browser-extension preference observation.
 */
export async function POST(req: Request) {
  return handleFormSubmission(req);
}

export async function OPTIONS(req: Request) {
  return handleFormSubmissionOptions(req);
}
