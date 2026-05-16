export interface QuestionOption {
	title: string;
	description: string;
}

interface AnnotatedRow {
	line: string;
	selected: boolean;
}

interface RenderSingleSelectRowsParams {
	options: QuestionOption[];
	selectedIndex: number;
	width: number;
	maxRows?: number;
}

function wrapText(text: string, width: number): string[] {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return [""];
	if (width <= 1) return normalized.split("");

	const words = normalized.split(" ");
	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		if (!current) {
			if (word.length <= width) {
				current = word;
			} else {
				for (let i = 0; i < word.length; i += width) {
					lines.push(word.slice(i, i + width));
				}
			}
			continue;
		}

		const candidate = `${current} ${word}`;
		if (candidate.length <= width) {
			current = candidate;
			continue;
		}

		lines.push(current);
		if (word.length <= width) {
			current = word;
		} else {
			current = "";
			for (let i = 0; i < word.length; i += width) {
				const chunk = word.slice(i, i + width);
				if (chunk.length === width || i + width < word.length) lines.push(chunk);
				else current = chunk;
			}
		}
	}

	if (current) lines.push(current);
	return lines;
}

function padLine(prefix: string, content: string): string {
	return `${prefix}${content}`.trimEnd();
}

interface ItemBlock {
	itemIndex: number;
	lines: string[];
}

function buildItemBlocks(
	options: QuestionOption[],
	width: number,
	selectedIndex: number,
): ItemBlock[] {
	const normalizedWidth = Math.max(12, width);

	return options.map((option, itemIndex) => {
		const pointer = itemIndex === selectedIndex ? "▶" : " ";
		const lines: string[] = [];

		const numberPrefix = `${pointer} ${itemIndex + 1}. `;
		const continuationPrefix = " ".repeat(numberPrefix.length);
		const titleLines = wrapText(option.title, Math.max(8, normalizedWidth - numberPrefix.length));
		titleLines.forEach((line, lineIndex) => {
			lines.push(padLine(lineIndex === 0 ? numberPrefix : continuationPrefix, line));
		});

		if (option.description) {
			const descriptionPrefix = "      ";
			const descriptionLines = wrapText(
				option.description,
				Math.max(8, normalizedWidth - descriptionPrefix.length),
			);
			descriptionLines.forEach((line) => {
				lines.push(padLine(descriptionPrefix, line));
			});
		}

		return { itemIndex, lines };
	});
}

function flatten(blocks: ItemBlock[], selectedIndex: number): AnnotatedRow[] {
	return blocks.flatMap((block) =>
		block.lines.map((line) => ({
			line,
			selected: block.itemIndex === selectedIndex,
		})),
	);
}

export function renderSingleSelectRows({
	options,
	selectedIndex,
	width,
	maxRows,
}: RenderSingleSelectRowsParams): AnnotatedRow[] {
	const itemCount = options.length;
	const blocks = buildItemBlocks(options, width, selectedIndex);
	const allRows = flatten(blocks, selectedIndex);

	if (!Number.isFinite(maxRows) || !maxRows || maxRows <= 0 || allRows.length <= maxRows) {
		return allRows;
	}

	const safeMaxRows = Math.max(1, Math.floor(maxRows));
	const selectedBlock = blocks[selectedIndex] ?? blocks[0];
	if (!selectedBlock) return [];

	const indicator = `  (${selectedIndex + 1}/${itemCount})`;
	const availableRows = safeMaxRows > 1 ? safeMaxRows - 1 : 1;

	if (selectedBlock.lines.length >= availableRows) {
		const visible = selectedBlock.lines.slice(0, availableRows).map((line) => ({
			line,
			selected: true,
		}));
		if (safeMaxRows > 1) visible.push({ line: indicator, selected: false });
		return visible.slice(0, safeMaxRows);
	}

	let start = selectedIndex;
	let end = selectedIndex + 1;
	let usedRows = selectedBlock.lines.length;

	while (true) {
		const nextCanFit = end < blocks.length && usedRows + blocks[end]!.lines.length <= availableRows;
		if (nextCanFit) {
			usedRows += blocks[end]!.lines.length;
			end += 1;
			continue;
		}

		const prevCanFit = start > 0 && usedRows + blocks[start - 1]!.lines.length <= availableRows;
		if (prevCanFit) {
			start -= 1;
			usedRows += blocks[start]!.lines.length;
			continue;
		}

		break;
	}

	const visible = flatten(blocks.slice(start, end), selectedIndex);
	visible.push({ line: indicator, selected: false });
	return visible.slice(0, safeMaxRows);
}
