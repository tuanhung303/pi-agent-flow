export const Type = {
	Object: (properties: Record<string, any>, options?: any) => ({ kind: "object", properties, ...options }),
	String: (options?: any) => ({ kind: "string", ...options }),
	Number: (options?: any) => ({ kind: "number", ...options }),
	Array: (items: any, options?: any) => ({ kind: "array", items, ...options }),
	Optional: (schema: any) => ({ kind: "optional", schema }),
	Boolean: (options?: any) => ({ kind: "boolean", ...options }),
	Union: (variants: any[]) => ({ kind: "union", variants }),
	Literal: (value: string) => ({ kind: "literal", value }),
};
