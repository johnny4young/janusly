/**
 * Declarative metadata for stable Janusly HTTP contracts.
 *
 * Used by route entries, the `/v1` dispatcher, runtime response validation,
 * and the OpenAPI 3.1 generator. A route without this metadata remains legacy
 * only and cannot be reached through the `/v1` alias lane.
 */

import type { ZodObject, ZodRawShape, ZodType } from "zod";

import type { ApiErrorCode } from "./error-codes";
import type { Permission } from "./permission-catalog";
import type { Role } from "./permissions";

export type ApiContractRequest = {
  /** Raw URL-query schema. Coercion is allowed; handlers keep ownership of the parsed values. */
  query?: ZodObject<ZodRawShape>;
  /** Query keys that must always be represented as arrays before Zod parsing. */
  repeatableQueryParams?: readonly string[];
  /** JSON body schema for future contracted mutation routes. */
  body?: ZodType;
};

export type ApiRouteContract = {
  /** Stable code-generation identifier. Unique across the whole registry. */
  operationId: string;
  /** OpenAPI path relative to the `/v1` server URL. */
  path: `/${string}`;
  summary: string;
  tags: readonly string[];
  request?: ApiContractRequest;
  /** Accepted successful JSON payload before the v1 envelope is applied. */
  response: ZodType;
  /** Route-specific errors; generic dispatcher errors are added automatically. */
  errorCodes: readonly ApiErrorCode[];
};

/** Pure route projection used by OpenAPI generation without importing handlers. */
export type ApiContractRouteDescriptor = {
  method: "GET" | "POST" | "DELETE";
  skipAuth?: boolean;
  role?: Role;
  permission?: Permission;
  contract: ApiRouteContract;
};
