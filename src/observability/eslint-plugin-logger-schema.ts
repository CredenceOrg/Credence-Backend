/**
 * ESLint Plugin for Logger Schema Validation
 *
 * This plugin ensures that structured logger calls use the allowlist schema
 * by flagging raw logger.info/error/warn/debug calls that bypass the schema.
 *
 * Rules:
 * - Flags logger.info/error/warn/debug calls with inline object literals
 * - Suggests wrapping in a named constant that can be validated
 */

import type { Rule } from "eslint";

const LOGGER_METHODS = new Set(["info", "error", "warn", "debug"]);

export const loggerSchemaValidation: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Flags raw logger calls with inline objects that bypass schema validation",
      recommended: true,
    },
    messages: {
      rawLoggerCall:
        "Raw logger.{{ method }}() call with inline object bypasses schema validation. " +
        "Create a named constant that matches a LogEventType schema from logSchemas.ts " +
        "and use logger.{{ method }}(logEvent, { eventType: YOUR_EVENT_TYPE })",
      suggestSchemaValidation:
        "Structured logs must be validated against logSchemas.ts to ensure PII redaction",
    },
  },

  create(context) {
    return {
      CallExpression(node: any) {
        // Check if this is a logger.X(...) call
        if (
          node.callee?.type === "MemberExpression" &&
          node.callee?.object?.name === "logger" &&
          LOGGER_METHODS.has(node.callee?.property?.name)
        ) {
          const method = node.callee.property.name;
          const firstArg = node.arguments[0];

          // Flag if first argument is an inline object literal
          if (firstArg?.type === "ObjectExpression") {
            context.report({
              node,
              messageId: "rawLoggerCall",
              data: { method },
              // Only report if it looks like structured logging (has multiple properties or specific fields)
              suggest: [
                {
                  messageId: "suggestSchemaValidation",
                  fix(fixer: any) {
                    // Suggest extracting to a named constant
                    return null; // Manual fix required
                  },
                },
              ],
            });
          }

          // Flag if second argument missing (no redaction context)
          if (
            firstArg &&
            node.arguments.length < 2 &&
            typeof firstArg === "object" &&
            firstArg.type !== "Literal" &&
            firstArg.type !== "Identifier"
          ) {
            // Only warn if it's structured (object/complex type)
            if (firstArg.type === "ObjectExpression") {
              context.report({
                node,
                message:
                  `Logger.${method}() should include redaction context. ` +
                  `Pass { eventType: 'event-type' } as second argument for schema-aware redaction.`,
              });
            }
          }
        }
      },
    };
  },
};

/**
 * Alternative simplified rule: Just flag any logger call with object literal as first arg
 * This is more permissive but still catches most cases
 */
export const loggerCallWithObjectRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Warns about potentially unredacted logger calls with inline objects",
      recommended: false,
    },
    messages: {
      inlineObjectLogger:
        "Logger.{{ method }}() with inline object should verify PII redaction via schema validation",
    },
  },

  create(context) {
    return {
      CallExpression(node: any) {
        if (
          node.callee?.type === "MemberExpression" &&
          node.callee?.object?.name === "logger" &&
          LOGGER_METHODS.has(node.callee?.property?.name)
        ) {
          const firstArg = node.arguments[0];

          if (firstArg?.type === "ObjectExpression") {
            const method = node.callee.property.name;
            context.report({
              node,
              messageId: "inlineObjectLogger",
              data: { method },
            });
          }
        }
      },
    };
  },
};
