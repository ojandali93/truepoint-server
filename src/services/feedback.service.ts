import { insertFeedback } from "../repositories/feedback.repository";

interface SubmitFeedbackArgs {
  category: string;
  message: string;
  app_version?: string;
  platform?: string;
}

export const submitFeedback = async (
  userId: string,
  args: SubmitFeedbackArgs,
) => {
  return insertFeedback({
    userId,
    category: args.category,
    message: args.message,
    appVersion: args.app_version,
    platform: args.platform,
  });
};
