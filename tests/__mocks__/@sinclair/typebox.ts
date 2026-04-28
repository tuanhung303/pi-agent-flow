export const Type = {
	Object: (properties: Record<string, any>, options?: any) => ({ kind: "object", properties, ...options }),
	String: (options?: any) => ({ kind: "string", ...options }),
	Array: (items: any, options?: any) => ({ kind: "array", items, ...options }),
	Optional: (schema: any) => ({ kind: "optional", schema }),
	Boolean: (options?: any) => ({ kind: "boolean", ...options }),
};
