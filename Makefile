# Makefile — macOS / Linux task runner for Jarela.
# Mirrors make.ps1 (Windows). Run `make help` for the target list.
# System-install targets (install-task etc.) use launchd on macOS.

SHELL        := /bin/bash
.SHELLFLAGS  := -eu -o pipefail -c

REPO_ROOT    := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
APP_NAME     := Jarela
LABEL        := com.jarela.app
PORT         := 4312
DATA_DIR     := $(HOME)/.jarela
INSTALL_DIR  := $(HOME)/Library/Application Support/$(APP_NAME)
PLIST        := $(HOME)/Library/LaunchAgents/$(LABEL).plist
LOG_DIR      := $(HOME)/Library/Logs/$(APP_NAME)
LOG_FILE     := $(LOG_DIR)/app.log
ARGS         ?=

CYAN := \033[36m
YEL  := \033[33m
DGY  := \033[90m
RED  := \033[31m
GRN  := \033[32m
RST  := \033[0m

.PHONY: help install dev isolated-dev build start lint test test-full icons clean \
	install-service uninstall-service start-service stop-service restart-service \
	install-task uninstall-task start-task stop-task restart-task \
	logs status push scan scan-staged install-hooks

help:
	@printf "$(CYAN)Jarela task runner$(RST) (macOS / Linux)\n"
	@printf "$(DGY)Usage: make <target>$(RST)\n\n"
	@printf "  $(YEL)install$(RST)         npm install\n"
	@printf "  $(YEL)dev$(RST)             Hot-reload dev server on http://localhost:$(PORT)\n"
	@printf "  $(YEL)isolated-dev$(RST)     Dev server with fresh temp state and a random port\n"
	@printf "  $(YEL)build$(RST)           Production build (standalone output)\n"
	@printf "  $(YEL)start$(RST)           Serve the standalone build on http://localhost:$(PORT)\n"
	@printf "  $(YEL)lint$(RST)            Run eslint\n"
	@printf "  $(YEL)test$(RST)            Live integration smoke tests\n"
	@printf "  $(YEL)test-full$(RST)       Extended live test suite\n"
	@printf "  $(YEL)icons$(RST)           Regenerate the logo / icon set\n"
	@printf "  $(YEL)clean$(RST)           Remove .next, build artefacts, node_modules cache\n"
	@printf "  $(YEL)install-service$(RST) Build the working tree (incl. uncommitted changes) and install\n"
	@printf "                  it as a per-user LaunchAgent (macOS). Flags: ARGS=--skip-build\n"
	@printf "  $(YEL)uninstall-service$(RST) Remove the LaunchAgent + installed files\n"
	@printf "  $(YEL)start-service$(RST)   launchctl kickstart $(LABEL)\n"
	@printf "  $(YEL)stop-service$(RST)    launchctl kill TERM gui/<uid>/$(LABEL)\n"
	@printf "  $(YEL)restart-service$(RST) Stop then start the LaunchAgent\n"
	@printf "  $(YEL)*-task$(RST)          Back-compat aliases for the service targets\n"
	@printf "  $(YEL)logs$(RST)            Tail the installed-task log file (Ctrl+C to stop)\n"
	@printf "  $(YEL)status$(RST)          Show LaunchAgent state + listener on :$(PORT)\n"
	@printf "  $(YEL)scan$(RST)            npm audit + secret and sensitive-term scans over the whole tree\n"
	@printf "  $(YEL)scan-staged$(RST)     Scan only staged changes\n"
	@printf "  $(YEL)install-hooks$(RST)   Point git at the repo's .githooks (pre-commit gate)\n"
	@printf "  $(YEL)push$(RST)            git push current branch to origin\n\n"
	@printf "$(DGY)Data dir: $(DATA_DIR)$(RST)\n"
	@printf "$(DGY)Override with JARELA_DB_DIR$(RST)\n"

install:
	@npm install

dev:
	@npm run dev

isolated-dev:
	@node scripts/isolated-dev.mjs

build:
	@npm run build

start:
	@npm start

lint:
	@npm run lint

test:
	@npm run test:live

test-full:
	@npm run test:live:full

icons:
	@node scripts/gen-logo.mjs

clean:
	@for p in .next node_modules/.cache tsconfig.tsbuildinfo; do \
	  if [ -e "$$p" ]; then \
	    printf "$(DGY)removing %s$(RST)\n" "$$p"; \
	    rm -rf "$$p"; \
	  fi; \
	done

# Delegates to scripts/install-to-system.sh (as make.ps1 delegates to the .ps1)
# so both entry points install the same way: the working tree as-is, committed
# or not, with dependencies re-synced when package-lock.json changed.
# Pass installer flags through ARGS, e.g. make install-service ARGS=--skip-build
install-service:
	@bash scripts/install-to-system.sh $(ARGS)
uninstall-service:
	@printf "$(CYAN)==> Removing $(APP_NAME) LaunchAgent$(RST)\n"
	@launchctl bootout gui/$$(id -u)/$(LABEL) 2>/dev/null || \
	 launchctl unload "$(PLIST)" 2>/dev/null || true
	@rm -f "$(PLIST)"
	@if [ -d "$(INSTALL_DIR)" ]; then \
	  printf "$(DGY)removing $(INSTALL_DIR)$(RST)\n"; \
	  rm -rf "$(INSTALL_DIR)"; \
	fi
	@printf "$(GRN)Removed.$(RST) Data dir $(DATA_DIR) preserved.\n"

start-service:
	@launchctl kickstart -k gui/$$(id -u)/$(LABEL)

stop-service:
	@launchctl kill TERM gui/$$(id -u)/$(LABEL) 2>/dev/null || true

restart-service:
	@$(MAKE) -s stop-service
	@sleep 1
	@$(MAKE) -s start-service

install-task: install-service
uninstall-task: uninstall-service
start-task: start-service
stop-task: stop-service
restart-task: restart-service

logs:
	@if [ ! -f "$(LOG_FILE)" ]; then \
	  printf "$(RED)log not found: $(LOG_FILE)$(RST) (install the task first?)\n"; exit 1; \
	fi
	@tail -n 50 -f "$(LOG_FILE)"

status:
	@printf "$(CYAN)=== LaunchAgent ===$(RST)\n"
	@launchctl print "gui/$$(id -u)/$(LABEL)" 2>/dev/null | grep -E '^\s*(state|pid|last exit code)' || echo "(not loaded)"
	@printf "\n$(CYAN)=== :$(PORT) listener ===$(RST)\n"
	@lsof -nP -iTCP:$(PORT) -sTCP:LISTEN 2>/dev/null || echo "(nothing listening)"
	@printf "\n$(CYAN)=== Data dir ===$(RST)\n"
	@DIR="$${JARELA_DB_DIR:-$(DATA_DIR)}"; \
	 if [ -d "$$DIR" ]; then ls -lh "$$DIR"; else echo "$$DIR does not exist yet"; fi

push:
	@branch=$$(git rev-parse --abbrev-ref HEAD); \
	 git push -u origin "$$branch"

scan:
	@printf "$(CYAN)=== npm audit (production deps, high+) ===$(RST)\n"
	@audit=0; npm audit --omit=dev --audit-level=high || audit=$$?; \
	 node scripts/scan-secrets.mjs --all; \
	 node scripts/scan-sensitive-terms.mjs --all; \
	 if [ $$audit -ne 0 ]; then echo "npm audit reported high/critical issues (exit $$audit)"; exit $$audit; fi

scan-staged:
	@node scripts/scan-secrets.mjs --staged
	@node scripts/scan-sensitive-terms.mjs --staged

install-hooks:
	@node scripts/setup-git-hooks.mjs
