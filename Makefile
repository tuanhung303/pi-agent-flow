.PHONY: local-link global-link

GLOBAL_PKG := $(shell npm root -g)/pi-agent-flow
LOCAL_PATH := $(shell pwd)

##@ Linking

local-link: ## Symlink local checkout as global pi-agent-flow package
	@echo "🔗  Linking local repo → global package..."
	@rm -rf "$(GLOBAL_PKG)" 2>/dev/null || true
	@npm link --silent
	@echo ""
	@RESOLVED=$$(cd "$$(dirname "$(GLOBAL_PKG)")" && cd "$$(readlink "$(GLOBAL_PKG)")" 2>/dev/null && pwd || echo ""); \
	if [ "$$RESOLVED" = "$(LOCAL_PATH)" ]; then \
		echo "✅  Linked: $(GLOBAL_PKG)"; \
		echo "    └─→ $(LOCAL_PATH)"; \
		echo ""; \
		echo "💡  Restart pi to pick up changes."; \
	else \
		echo "❌  Link failed — check npm link output above."; \
		exit 1; \
	fi

global-link: ## Restore published npm version (remove local symlink)
	@echo "📦  Restoring published pi-agent-flow from npm registry..."
	@npm uninstall -g pi-agent-flow --silent 2>/dev/null || true
	@npm install -g pi-agent-flow@latest --silent
	@echo ""
	@if [ ! -L "$(GLOBAL_PKG)" ]; then \
		echo "✅  Restored: $(GLOBAL_PKG)"; \
		echo "    📋  $$(npm ls -g pi-agent-flow --depth=0 2>/dev/null | tail -1)"; \
	else \
		echo "❌  Restore failed — symlink still present."; \
		exit 1; \
	fi

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'
