import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Locale = "en" | "es" | "fr" | "pt-BR";
type Params = Record<string, string | number>;

const translations: Record<Exclude<Locale, "en">, Record<string, string>> = {
	es: {
		"flow.confirmProject.title": "¿Ejecutar flujos locales del proyecto?",
		"flow.confirmProject.body": "Flujos: {names}\nOrigen: {dir}\n\nLos flujos del proyecto están controlados por el repositorio. Continúa solo con repositorios de confianza.",
		"flow.canceledProject": "Cancelado: los flujos locales del proyecto no fueron aprobados.",
		"flow.blockedProjectNonUi": "Bloqueado: se requiere confirmar los flujos locales del proyecto en modo no visual.\nFlujos: {names}\nVuelve a ejecutar con confirmProjectFlows: false si confías en ellos.",
	},
	fr: {
		"flow.confirmProject.title": "Exécuter les flux locaux du projet ?",
		"flow.confirmProject.body": "Flux : {names}\nSource : {dir}\n\nLes flux du projet sont contrôlés par le dépôt. Continuez uniquement pour des dépôts de confiance.",
		"flow.canceledProject": "Annulé : les flux locaux du projet n’ont pas été approuvés.",
		"flow.blockedProjectNonUi": "Bloqué : la confirmation des flux locaux du projet est requise en mode non visuel.\nFlux : {names}\nRelancez avec confirmProjectFlows: false si vous leur faites confiance.",
	},
	"pt-BR": {
		"flow.confirmProject.title": "Executar fluxos locais do projeto?",
		"flow.confirmProject.body": "Fluxos: {names}\nOrigem: {dir}\n\nOs fluxos do projeto são controlados pelo repositório. Continue apenas em repositórios confiáveis.",
		"flow.canceledProject": "Cancelado: os fluxos locais do projeto não foram aprovados.",
		"flow.blockedProjectNonUi": "Bloqueado: a confirmação dos fluxos locais do projeto é obrigatória no modo sem interface.\nFluxos: {names}\nExecute novamente com confirmProjectFlows: false se confiar neles.",
	},
};

let currentLocale: Locale = "en";

export function initI18n(pi: ExtensionAPI): void {
	const events = (pi as ExtensionAPI & { events?: { emit?: (name: string, payload: unknown) => void } }).events;
	events?.emit?.("pi-core/i18n/registerBundle", {
		namespace: "pi-agent-flow",
		defaultLocale: "en",
		locales: translations,
	});

	events?.emit?.("pi-core/i18n/requestApi", {
		onReady: (api: { getLocale?: () => string; onLocaleChange?: (cb: (locale: string) => void) => void }) => {
			const next = api.getLocale?.();
			if (isLocale(next)) currentLocale = next;
			api.onLocaleChange?.((locale) => {
				if (isLocale(locale)) currentLocale = locale;
			});
		},
	});
}

export function t(key: string, fallback: string, params: Params = {}): string {
	const template = currentLocale === "en" ? fallback : translations[currentLocale]?.[key] ?? fallback;
	return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
}

function isLocale(locale: string | undefined): locale is Locale {
	return locale === "en" || locale === "es" || locale === "fr" || locale === "pt-BR";
}
