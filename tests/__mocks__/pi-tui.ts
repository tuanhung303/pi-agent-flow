export class Text {
	text: string;
	constructor(text: string, _width: number, _height: number) {
		this.text = text;
	}
	toString() {
		return this.text;
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
}

export class Markdown {
	text: string;
	constructor(text: string, _width: number, _height: number, _theme?: any) {
		this.text = text;
	}
}

export class Spacer {
	constructor(_height: number) {}
}
