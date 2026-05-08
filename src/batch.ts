/**
 * batch — re-export barrel.
 *
 * Delegates to src/batch/ submodules. This file exists for backward
 * compatibility with existing import paths.
 */
export {
	WeavePatchParams,
	BatchReadParams,
	createBatchTool,
	createBatchReadTool,
} from "./batch/index.js";

export {
	BashProcessTracker,
	createBatchBashPollTool,
	pollBatchBashResults,
} from "./batch/index.js";

export { suggestSimilarFiles } from "./batch/execute.js";
export { isWithinDirectory } from "./batch/fuzzy-edit.js";

export type {
	BashOpResult,
	PendingBashResult,
	OpResult,
	FileOpInput,
} from "./batch/constants.js";
