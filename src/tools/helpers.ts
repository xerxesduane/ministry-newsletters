// Shared helpers for tool handlers.

import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js'

/** A plain text result. */
export function text(body: string): CallToolResult {
    return {content: [{type: 'text', text: body}]}
}

/** A result that also carries structured data, for clients that can use it. */
export function data(body: string, structured: Record<string, unknown>): CallToolResult {
    return {content: [{type: 'text', text: body}], structuredContent: structured}
}

/** An error result. Returned rather than thrown, so the model can read and act on it. */
export function fail(body: string): CallToolResult {
    return {content: [{type: 'text', text: body}], isError: true}
}

/** Render a list as a numbered block, or a stated empty message. */
export function list_or_empty<T>(items: T[], empty: string, render: (item: T, i: number) => string)
        : string {
    if (!items.length) {
        return empty
    }
    return items.map(render).join('\n')
}

/** Wrap an async handler so an unexpected throw becomes a readable tool error. */
export function guard<A extends unknown[]>(handler: (...args: A) => Promise<CallToolResult>) {
    return async (...args: A): Promise<CallToolResult> => {
        try {
            return await handler(...args)
        } catch (error) {
            return fail(error instanceof Error ? error.message : String(error))
        }
    }
}

/** Wrap a synchronous handler the same way. */
export function guard_sync<A extends unknown[]>(handler: (...args: A) => CallToolResult) {
    return (...args: A): CallToolResult => {
        try {
            return handler(...args)
        } catch (error) {
            return fail(error instanceof Error ? error.message : String(error))
        }
    }
}
