import { Worker } from "bullmq";
import { connection } from "./queue";

export const worker = new Worker(
  "workflow-nodes",
  async (job) => {
    console.log("Executing node", job.data);
  },
  {
    connection,
    concurrency: 10,
  }
);
