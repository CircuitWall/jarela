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
NODE_BIN     := $(shell command -v node 2>/dev/null)

CYAN := \033[36m
YEL  := \033[33m
DGY  := \033[90m
RED  := \033[31m
GRN  := \033[32m
RST  := \033[0m

.PHONY: help install dev build start lint test test-full icons clean \
        install-task uninstall-task start-task stop-task restart-task \
        logs status push

help:
	@printf "$(CYAN)Jarela task runner$(RST) (macOS / Linux)\n"
	@printf "$(DGY)Usage: make <target>$(RST)\n\n"
	@printf "  $(YEL)install$(RST)         npm install\n"
	@printf "  $(YEL)dev$(RST)             Hot-reload dev server on http://localhost:$(PORT)\n"
	@printf "  $(YEL)build$(RST)           Production build (standalone output)\n"
	@printf "  $(YEL)start$(RST)           Serve the standalone build on http://localhost:$(PORT)\n"
	@printf "  $(YEL)lint$(RST)            Run eslint\n"
	@printf "  $(YEL)test$(RST)            Live integration smoke tests\n"
	@printf "  $(YEL)test-full$(RST)       Extended live test suite\n"
	@printf "  $(YEL)icons$(RST)           Regenerate the logo / icon set\n"
	@printf "  $(YEL)clean$(RST)           Remove .next, build artefacts, node_modules cache\n"
	@printf "  $(YEL)install-task$(RST)    Install per-user LaunchAgent (auto-start at login)\n"
	@printf "  $(YEL)uninstall-task$(RST)  Remove the LaunchAgent + installed files\n"
	@printf "  $(YEL)start-task$(RST)      launchctl kickstart $(LABEL)\n"
	@printf "  $(YEL)stop-task$(RST)       launchctl kill TERM gui/<uid>/$(LABEL)\n"
	@printf "  $(YEL)restart-task$(RST)    Stop then start the LaunchAgent\n"
	@printf "  $(YEL)logs$(RST)            Tail the installed-task log file (Ctrl+C to stop)\n"
	@printf "  $(YEL)status$(RST)          Show LaunchAgent state + listener on :$(PORT)\n"
	@printf "  $(YEL)push$(RST)            git push current branch to the jarela remote\n\n"
	@printf "$(DGY)Data dir: $(DATA_DIR)$(RST)\n"
	@printf "$(DGY)Override with JARELA_DB_DIR$(RST)\n"

install:
	@npm install

dev:
	@npm run dev

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

install-task: build
	@printf "$(CYAN)==> Installing $(APP_NAME) to $(INSTALL_DIR)$(RST)\n"
	@if [ -z "$(NODE_BIN)" ]; then \
	  printf "$(RED)node not found on PATH. Install Node.js first.$(RST)\n"; exit 1; \
	fi
	@if [ ! -f .next/standalone/server.js ]; then \
	  printf "$(RED)Standalone build missing at .next/standalone/server.js$(RST)\n"; exit 1; \
	fi
	@launchctl bootout gui/$$(id -u)/$(LABEL) 2>/dev/null || true
	@# Free port $(PORT) before bootstrap. launchd spawns the child under
	@# RunAtLoad immediately; if anything else (a stray `next dev`, a
	@# previous unmanaged install, etc.) is holding the socket, the child
	@# fails with EADDRINUSE and bootstrap surfaces that as the cryptic
	@# "Bootstrap failed: 5: Input/output error".
	@for pid in $$(lsof -nP -iTCP:$(PORT) -sTCP:LISTEN -t 2>/dev/null); do \
	  printf "$(YEL)stopping process $$pid holding port $(PORT)$(RST)\n"; \
	  kill -TERM "$$pid" 2>/dev/null || true; \
	done
	@# Brief settle so launchd doesn't see the just-killed socket in TIME_WAIT.
	@sleep 1
	@# Clear any "disabled" flag a prior failed bootstrap may have left behind.
	@launchctl enable "gui/$$(id -u)/$(LABEL)" 2>/dev/null || true
	@mkdir -p "$(INSTALL_DIR)" "$(LOG_DIR)" "$(HOME)/Library/LaunchAgents"
	@find "$(INSTALL_DIR)" -mindepth 1 -delete 2>/dev/null || true
	@cp -R .next/standalone/. "$(INSTALL_DIR)/"
	@mkdir -p "$(INSTALL_DIR)/.next"
	@cp -R .next/static "$(INSTALL_DIR)/.next/static"
	@cp -R public "$(INSTALL_DIR)/public"
	@COMMIT=$$(git rev-parse --short HEAD 2>/dev/null || echo unknown); \
	 INSTALLED_AT=$$(date -u +%Y-%m-%dT%H:%M:%SZ); \
	 printf '{\n  "installedAt": "%s",\n  "commit": "%s",\n  "sourceRepo": "%s",\n  "node": "%s",\n  "port": %s,\n  "dbDir": "%s"\n}\n' \
	   "$$INSTALLED_AT" "$$COMMIT" "$(REPO_ROOT)" "$(NODE_BIN)" "$(PORT)" "$(DATA_DIR)" \
	   > "$(INSTALL_DIR)/install.json"
	@printf "$(CYAN)==> Writing LaunchAgent $(PLIST)$(RST)\n"
	@{ \
	  echo '<?xml version="1.0" encoding="UTF-8"?>'; \
	  echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'; \
	  echo '<plist version="1.0"><dict>'; \
	  echo '  <key>Label</key><string>$(LABEL)</string>'; \
	  echo '  <key>ProgramArguments</key>'; \
	  echo '  <array>'; \
	  echo '    <string>$(NODE_BIN)</string>'; \
	  echo '    <string>$(INSTALL_DIR)/server.js</string>'; \
	  echo '  </array>'; \
	  echo '  <key>WorkingDirectory</key><string>$(INSTALL_DIR)</string>'; \
	  echo '  <key>EnvironmentVariables</key>'; \
	  echo '  <dict>'; \
	  echo '    <key>PORT</key><string>$(PORT)</string>'; \
	  echo '    <key>HOSTNAME</key><string>127.0.0.1</string>'; \
	  echo '    <key>NODE_ENV</key><string>production</string>'; \
	  echo '    <key>JARELA_DB_DIR</key><string>$(DATA_DIR)</string>'; \
	  echo '  </dict>'; \
	  echo '  <key>RunAtLoad</key><true/>'; \
	  echo '  <key>KeepAlive</key><true/>'; \
	  echo '  <key>ThrottleInterval</key><integer>10</integer>'; \
	  echo '  <key>StandardOutPath</key><string>$(LOG_FILE)</string>'; \
	  echo '  <key>StandardErrorPath</key><string>$(LOG_FILE)</string>'; \
	  echo '</dict></plist>'; \
	} > "$(PLIST)"
	@if ! launchctl bootstrap gui/$$(id -u) "$(PLIST)"; then \
	  printf "$(RED)launchctl bootstrap failed.$(RST) Common causes:\n"; \
	  printf "  - port $(PORT) already in use (check: lsof -nP -iTCP:$(PORT) -sTCP:LISTEN)\n"; \
	  printf "  - the agent is loaded in another session; try: launchctl bootout gui/$$(id -u)/$(LABEL)\n"; \
	  printf "  - the agent is marked disabled; try: launchctl enable gui/$$(id -u)/$(LABEL)\n"; \
	  exit 1; \
	fi
	@launchctl kickstart -k gui/$$(id -u)/$(LABEL) 2>/dev/null || true
	@printf "$(GRN)Installed $(APP_NAME) at $(INSTALL_DIR)$(RST)\n"
	@printf "  URL:   http://localhost:$(PORT)\n"
	@printf "  Data:  $(DATA_DIR)\n"
	@printf "  Logs:  $(LOG_FILE)\n"
	@printf "  Stop:  make stop-task\n"
	@printf "  Off:   make uninstall-task\n"

uninstall-task:
	@printf "$(CYAN)==> Removing $(APP_NAME) LaunchAgent$(RST)\n"
	@launchctl bootout gui/$$(id -u)/$(LABEL) 2>/dev/null || \
	 launchctl unload "$(PLIST)" 2>/dev/null || true
	@rm -f "$(PLIST)"
	@if [ -d "$(INSTALL_DIR)" ]; then \
	  printf "$(DGY)removing $(INSTALL_DIR)$(RST)\n"; \
	  rm -rf "$(INSTALL_DIR)"; \
	fi
	@printf "$(GRN)Removed.$(RST) Data dir $(DATA_DIR) preserved.\n"

start-task:
	@launchctl kickstart -k gui/$$(id -u)/$(LABEL)

stop-task:
	@launchctl kill TERM gui/$$(id -u)/$(LABEL) 2>/dev/null || true

restart-task:
	@$(MAKE) -s stop-task
	@sleep 1
	@$(MAKE) -s start-task

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
	 git push jarela "$$branch"
