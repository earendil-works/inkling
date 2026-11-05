PNPM ?= pnpm

.PHONY: build check dev format format-check lint setup test typecheck

# Installs dependencies.
setup:
	$(PNPM) install

dev:
	$(PNPM) run dev

build:
	$(PNPM) run build

format:
	$(PNPM) run format

format-check:
	$(PNPM) run format:check

lint:
	$(PNPM) run lint

test:
	$(PNPM) run test

typecheck:
	$(PNPM) run typecheck

check: format-check lint typecheck test build
