/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import type * as contactMessages from "../contactMessages.js";
import type * as http from "../http.js";
import type * as lib_emailDomain from "../lib/emailDomain.js";
import type * as lib_emailShape from "../lib/emailShape.js";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  contactMessages: typeof contactMessages;
  http: typeof http;
  "lib/emailDomain": typeof lib_emailDomain;
  "lib/emailShape": typeof lib_emailShape;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
