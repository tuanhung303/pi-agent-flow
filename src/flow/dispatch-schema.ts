/**
 * Shared pre-dispatch op schemas for the `flow` and `trace` tools.
 *
 * Both tools accept the same `dispatch` array of pre-flight tool calls; the
 * schemas used to be duplicated in src/index.ts and src/tools/trace.ts (to
 * avoid a circular import) and had drifted apart. This module is the single
 * source of truth — keep it alias-lenient and in sync with the normalizer in
 * src/tools/trace-dispatch-prep.ts and the registry in src/flow/op-aliases.ts.
 */

import { Type } from "@sinclair/typebox";

export const BatchDispatchOp = Type.Object({
	tool: Type.Literal("batch"),
	ops: Type.Array(Type.Object({
		o: Type.String(),
		p: Type.Optional(Type.String()),
		c: Type.Optional(Type.String()),
		e: Type.Optional(Type.Array(Type.Object({ f: Type.String(), r: Type.String() }))),
		s: Type.Optional(Type.Number()),
		l: Type.Optional(Type.Union([Type.Number(), Type.Boolean()])),
		i: Type.Optional(Type.Union([Type.String(), Type.Boolean()])),
		t: Type.Optional(Type.Union([Type.Number(), Type.String()])),
		h: Type.Optional(Type.String()),
		q: Type.Optional(Type.String()),
		n: Type.Optional(Type.Number()),
		u: Type.Optional(Type.Number()),
	}), { description: "File/batch operations matching the batch tool schema. Aliases accepted: path=p, content=c, edits=e, offset=s, limit=l, ignoreCase=i, query=q, maxCount=n. Canonical wins." }),
});

export const BashDispatchOp = Type.Object({
	tool: Type.Literal("bash"),
	ops: Type.Array(Type.Object({
		c: Type.String({ description: "Shell command. Alias: cmd." }),
		h: Type.Optional(Type.String({ description: "Working directory override. Alias: cwd." })),
		t: Type.Optional(Type.Number({ description: "Timeout in ms. Alias: timeout." })),
	}), { description: "Bash command objects." }),
});

export const WebDispatchOp = Type.Object({
	tool: Type.Literal("web"),
	ops: Type.Array(Type.Object({
		o: Type.Union([Type.Literal("search"), Type.Literal("fetch")]),
		q: Type.Optional(Type.String()),
		u: Type.Optional(Type.String()),
		f: Type.Optional(Type.String()),
	}), { description: "Web operations matching the web tool schema." }),
});

export const DispatchOpSchema = Type.Union([BatchDispatchOp, BashDispatchOp, WebDispatchOp], {
	description: "Pre-dispatch tool call with discriminated tool type and typed ops array. Wrapper aliases: t=tool, o=ops. Canonical wins.",
});
