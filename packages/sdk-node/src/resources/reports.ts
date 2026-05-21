/**
 * Reports resource — downloads run-explain artefacts.
 *
 * The server emits markdown (default) or JSON via the `format` query
 * parameter. Filename is read from `Content-Disposition` per the same
 * RFC 5987 + ASCII fallback the web's `downloadFromApi` uses, so SDK
 * and web behaviour stay consistent.
 */

import { sendApiRequest, type AttachmentResponse } from "../request.ts";
import type { JanuslyClientConfig, JanuslyRequestOptions } from "../types.ts";

/** Closed enum of formats the server emits. */
export type RunExplainFormat = "markdown" | "json";

export type RunExplainExport = {
  /** Raw report body (markdown text or JSON-stringified payload). */
  body: string;
  /** Filename suggestion parsed from Content-Disposition. */
  filename: string;
  /** Server-side content type (`text/markdown` or `application/json`). */
  contentType: string;
};

export class ReportsResource {
  private readonly config: JanuslyClientConfig;

  constructor(config: JanuslyClientConfig) {
    this.config = config;
  }

  /**
   * GET /reports/run-explain — fetch the run-explain artefact for one run.
   *
   * Defaults to `markdown` format. The returned `body` is the raw artefact
   * text (no parsing). Callers can write it to disk via Node's `fs/promises`
   * or POST it to a downstream service.
   */
  async exportRunExplain(
    runId: string,
    query?: { format?: RunExplainFormat },
    options?: JanuslyRequestOptions,
  ): Promise<RunExplainExport> {
    const params = new URLSearchParams();
    params.set("runId", runId);
    if (query?.format) params.set("format", query.format);

    const attachment = (await sendApiRequest(
      this.config,
      {
        method: "GET",
        path: `/reports/run-explain?${params.toString()}`,
        asAttachment: true,
      },
      options,
    )) as AttachmentResponse;

    return attachment;
  }
}
