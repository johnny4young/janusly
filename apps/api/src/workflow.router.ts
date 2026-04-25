import { router, publicProcedure } from "./trpc";
import { z } from "zod";
import { WorkflowSchema } from "@workflow-engine/shared/src/workflow";
import { startRun } from "@workflow-engine/engine/src/start-run";

export const workflowRouter = router({
  start: publicProcedure
    .input(WorkflowSchema)
    .mutation(async ({ input }) => {
      return startRun(input);
    }),

  status: publicProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ input }) => {
      return { runId: input.runId, status: "not-implemented" };
    }),
});
