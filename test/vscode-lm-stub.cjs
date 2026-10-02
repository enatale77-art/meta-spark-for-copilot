/**
 * `vscode` stub with the Language Model value classes needed by the provider
 * tool pipeline (`src/provider/tools`, `convert`, `replay`). Pure data holders
 * only — no editor behavior.
 */
class LanguageModelTextPart {
	constructor(value) {
		this.value = value;
	}
}
class LanguageModelThinkingPart {
	constructor(value) {
		this.value = value;
	}
}
class LanguageModelToolCallPart {
	constructor(callId, name, input) {
		this.callId = callId;
		this.name = name;
		this.input = input;
	}
}
class LanguageModelToolResultPart {
	constructor(callId, content) {
		this.callId = callId;
		this.content = content;
	}
}
class LanguageModelDataPart {
	constructor(data, mimeType) {
		this.data = data;
		this.mimeType = mimeType;
	}
}

module.exports = {
	env: { language: 'en' },
	LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
	LanguageModelTextPart,
	LanguageModelThinkingPart,
	LanguageModelToolCallPart,
	LanguageModelToolResultPart,
	LanguageModelDataPart,
};
