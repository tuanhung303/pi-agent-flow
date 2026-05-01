/** Declaration for runner-cli.js */
export function parseFlowCliArgs(argv: string[]): {
	extensionArgs: string[];
	alwaysProxy: string[];
	fallbackModel?: string;
	fallbackThinking?: string;
	fallbackTools?: string;
	fallbackNoTools: boolean;
	tieredModels: {
		lite?: string;
		flash?: string;
		full?: string;
	};
};
