# Web Frontend Development Guide

## Tech Stack

- **Language**: TypeScript with strict mode enabled
- **Styling**: Tailwind CSS with Vite plugin
- **UI Components**: shadcn/ui with Radix UI primitives
- **Icons**: Lucide React
- **Build Tool**: Vite with React plugin for Fast Refresh

## Naming Conventions

- **ALWAYS prefer readability over brevity** when naming things we control (variables, functions, classes, files). A few extra characters typed once saves thousands of moments of confusion reading code later.
- When naming variables, consider potential ambiguity in context (e.g., `data` could mean anything — prefer `userProfileData`; `result` tells you nothing — prefer `validatedToken`).
- AI tends to over-index on brief names from training data. Actively resist this.

## TypeScript

- Avoid `any` type unless absolutely necessary — strict mode is enabled
- Leverage TypeScript's type system to catch errors at compile time
