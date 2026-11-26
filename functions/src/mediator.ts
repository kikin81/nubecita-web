import {type MediatorResponse, mediatorError} from "./responses";

/** The parts of an incoming HTTP request the backend looks at. */
export interface MediatorRequest {
  method: string;
  /** Path as received, without the query string. */
  path: string;
  /** Header names lower-cased. */
  headers: Record<string, string | undefined>;
  /** Raw `application/x-www-form-urlencoded` body. */
  body: string;
}

/**
 * Entry point for every request. Kept free of Firebase types so it can be
 * exercised directly in tests.
 *
 * Scaffold: no route is mediated yet, so everything is a 404 that forwards
 * nothing.
 */
export async function handleRequest(_request: MediatorRequest): Promise<MediatorResponse> {
  return mediatorError(404, "not_found", false);
}
