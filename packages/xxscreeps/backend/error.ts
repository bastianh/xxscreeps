/**
 * Thrown by an endpoint to send an error payload to the client. The route wrapper renders these as
 * `{ error: message }`; any other exception is an internal server error and is logged as such.
 *
 * The status defaults to 200 because the official client expects most API failures to arrive as a
 * successful response carrying an `error` property.
 */
export class ClientError extends Error {
	readonly status: number;

	constructor(message: string, status = 200) {
		super(message);
		this.name = 'ClientError';
		this.status = status;
	}
}
