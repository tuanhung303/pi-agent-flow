export class Text {
	text: string;
	constructor(text: string, _width: number, _height: number) {
		this.text = text;
	}
	toString() {
		return this.text;
	}
	setText(text: string) {
		this.text = text;
	}
	invalidate() {}
	render(_width: number): string[] {
		return this.text.split("\n");
	}
}

export class TruncatedText {
	text: string;
	constructor(text: string, _paddingX: number = 0, _paddingY: number = 0) {
		this.text = text;
	}
	toString() {
		return this.text;
	}
}

export class Container {
	children: any[] = [];
	addChild(child: any) {
		this.children.push(child);
	}
	clear() {
		this.children = [];
	}
	invalidate() {}
	render(_width: number): string[] {
		return [];
	}
}

export class Markdown {
	text: string;
	constructor(text: string, _width: number, _height: number, _theme?: any) {
		this.text = text;
	}
	setText(text: string) {
		this.text = text;
	}
	render(_width: number): string[] {
		return this.text.split("\n");
	}
	invalidate() {}
}

export class Spacer {
	constructor(_height: number) {}
	invalidate() {}
	render(_width: number): string[] {
		return [];
	}
}

export class Editor {
	disableSubmit = false;
	onSubmit?: (text: string) => void;
	constructor(_tui: any, _theme: any) {}
	handleInput(_data: string) {}
	invalidate() {}
	render(_width: number): string[] {
		return [];
	}
}

export namespace Key {
	export function ctrl(key: string): string {
		return `ctrl+${key}`;
	}
	export function shift(key: string): string {
		return `shift+${key}`;
	}
	export function alt(key: string): string {
		return `alt+${key}`;
	}
	export function super_(key: string): string {
		return `super+${key}`;
	}
	export const space = "space";
	export const escape = "escape";
	export const backspace = "backspace";
	export const tab = "tab";
}

export function matchesKey(_data: string, _key: string): boolean {
	return false;
}

export function fuzzyFilter<T>(items: T[], _query: string, _accessor: (item: T) => string): T[] {
	return items;
}

export function decodeKittyPrintable(_data: string): string | undefined {
	return undefined;
}

export function truncateToWidth(text: string, _width: number, _ellipsis?: string, _padRight?: boolean): string {
	return text;
}

export function wrapTextWithAnsi(text: string, _width: number): string[] {
	return text.split("\n");
}
