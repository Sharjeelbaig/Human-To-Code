/**
 * Declarative compiler-mode rules that map request triggers to required facets.
 */
import {
  hasAction,
  hasBreakpoint,
  hasChartType,
  hasColor,
  hasColorList,
  hasCount,
  hasDataSource,
  hasDirectionOrAngle,
  hasDuration,
  hasEasing,
  hasEnumeratedList,
  hasErrors,
  hasFontFamily,
  hasFontSize,
  hasFontWeight,
  hasHttpMethod,
  hasIdentifierList,
  hasItemContent,
  hasLabelText,
  hasNamedTarget,
  hasPath,
  hasProperty,
  hasRequestShape,
  hasResponsiveChange,
  hasResponseShape,
  hasSortDirection,
  hasSortKey,
  hasSubmitTarget,
  hasTrigger,
  hasUnitValue,
  hasValidation,
  type FacetDetector,
} from "./facets.ts";

export type DiagnosticSeverity = "error" | "warning";

export interface RequiredFacet {
  id: string;
  question: string;
  example: string;
  satisfiedBy: FacetDetector;
}

export interface RequirementRule {
  id: string;
  trigger: RegExp;
  extensions?: readonly string[];
  severity: DiagnosticSeverity;
  facets: readonly RequiredFacet[];
}

const facet = (
  id: string,
  question: string,
  example: string,
  satisfiedBy: FacetDetector,
): RequiredFacet => ({ id, question, example, satisfiedBy });

/** Static, deterministic starter vocabulary for compiler-mode diagnostics. */
export const REQUIREMENT_RULES: readonly RequirementRule[] = [
  {
    id: "gradient",
    trigger: /\bgradients?\b/iu,
    severity: "error",
    facets: [
      facet("colors", "Which colors, in order?", "#0A84FF to #30D158", hasColorList),
      facet("direction", "Which direction or angle?", "to bottom, or 135deg", hasDirectionOrAngle),
      facet("target", "Which element does it apply to?", "the hero section, or .card", hasNamedTarget),
    ],
  },
  {
    id: "table",
    trigger: /\bdata\s+grids?\b|\b(?:add|build|create|display|render|show)\s+(?:an?\s+)?tables?\b|\b(?:data|html)\s+tables?\b/iu,
    severity: "error",
    facets: [
      facet("columns", "Which columns should it have?", "name, email, and role", hasIdentifierList),
      facet("rowsOrDataSource", "How many rows are there, or where do they come from?", "from the users API", (text, context) => hasCount(text, context) || hasDataSource(text, context)),
      facet("cellContent", "What should each cell contain?", "each row shows name, email, and role", hasItemContent),
    ],
  },
  {
    id: "chart",
    trigger: /\bcharts?\b|\b(?:add|build|create|display|draw|plot|render|show)\s+(?:an?\s+)?graphs?\b|\bgraphs?\s+(?:components?|visualizations?|widgets?)\b/iu,
    severity: "error",
    facets: [
      facet("chartType", "Which kind of chart?", "a line chart", hasChartType),
      facet("dataSource", "What data does it plot?", "from the monthlyRevenue array", hasDataSource),
      facet("labels", "What are the axes or series labels?", "x-axis Month and y-axis Revenue", hasIdentifierList),
    ],
  },
  {
    id: "button",
    trigger: /\b(?:buttons?|links?)\b/iu,
    severity: "error",
    facets: [
      facet("label", "What text should it display?", 'labelled "Save changes"', hasLabelText),
      facet("action", "What should happen when it is clicked?", "submit the form", hasAction),
      facet("placement", "Where should it appear?", "in the profile form footer", hasNamedTarget),
    ],
  },
  {
    id: "animation",
    trigger: /\b(?:animations?|animate[ds]?)\b|\b(?:add|apply|create|set|use)\s+(?:an?\s+)?transitions?\b|\b(?:css|visual)\s+transitions?\b/iu,
    severity: "error",
    facets: [
      facet("property", "What should move or change?", "fade the modal opacity", hasProperty),
      facet("duration", "How long should it take?", "200ms", hasDuration),
      facet("easing", "Which easing curve should it use?", "ease-out", hasEasing),
      facet("trigger", "What starts it?", "when the modal opens", hasTrigger),
    ],
  },
  {
    id: "form",
    trigger: /\bforms?\b|\binputs?\s+(?:boxes?|controls?|elements?|fields?)\b|\b(?:add|build|create|render)\s+(?:an?\s+)?inputs?\b/iu,
    severity: "error",
    facets: [
      facet("fields", "Which fields should it contain?", "name, email, and phone", hasEnumeratedList),
      facet("validation", "How should those fields be validated?", "email is required and must be valid", hasValidation),
      facet("submitTarget", "Where should it submit?", "POST it to /api/contact", hasSubmitTarget),
    ],
  },
  {
    id: "endpoint",
    trigger: /\b(?:api\s+)?endpoints?\b|\b(?:api|express|http|web)\s+routes?\b|\b(?:add|create|define|implement|register)\s+(?:an?\s+)?(?:api\s+)?routes?\b/iu,
    severity: "error",
    facets: [
      facet("method", "Which HTTP method?", "POST", hasHttpMethod),
      facet("path", "Which path?", "/api/orders/:id", hasPath),
      facet("request", "What is the request shape?", "a JSON body with quantity and sku", hasRequestShape),
      facet("response", "What does it return?", "200 with an Order JSON object", hasResponseShape),
      facet("errors", "Which error cases should it handle?", "404 when the order is missing", hasErrors),
    ],
  },
  {
    id: "list",
    trigger: /\b(?:add|build|create|display|render|show)\s+(?:an?\s+|\d+\s+)?(?:lists?|cards?)\b|\b(?:lists?|cards?)\s+(?:components?|views?|widgets?)\b|\b(?:add|display|render|show)\s+(?:a\s+)?repeat(?:ed|ing)?\b/iu,
    severity: "error",
    facets: [
      facet("items", "How many items are there, or where do they come from?", "six cards, or from the projects array", (text, context) => hasCount(text, context) || hasDataSource(text, context)),
      facet("content", "What goes in each item?", "each card shows title, image, and summary", hasItemContent),
    ],
  },
  {
    id: "sort",
    trigger: /\b(?:sort|sorting|ordering|order\s+by)\b/iu,
    severity: "error",
    facets: [
      facet("key", "Which field should be used?", "by createdAt", hasSortKey),
      facet("direction", "Ascending or descending?", "newest first", hasSortDirection),
    ],
  },
  {
    id: "responsive",
    trigger: /\b(?:responsive|breakpoints?)\b|\bmobile\s+(?:breakpoints?|design|layouts?|navigation|styles?|views?)\b/iu,
    severity: "error",
    facets: [
      facet("breakpoints", "Which breakpoints should be used?", "below 768px", hasBreakpoint),
      facet("changes", "What changes at each breakpoint?", "below 768px stack the cards", hasResponsiveChange),
    ],
  },
  {
    id: "color",
    trigger: /\b(?:add|apply|change|set|use)\s+(?:a\s+|the\s+)?colou?rs?\b|\b(?:background|border|font|text)\s+colou?rs?\b|\b(?:themes?|dark\s+mode)\b/iu,
    severity: "error",
    facets: [
      facet("value", "Which exact color or named token?", "#0A84FF, or brand blue", hasColor),
      facet("target", "What should the color apply to?", "the page background", hasNamedTarget),
    ],
  },
  {
    id: "spacing",
    trigger: /\b(?:spacing|padding|margin)\b|\b(?:add|apply|change|make|set|use)\s+(?:the\s+)?(?:sizes?|width|height)\b|\b(?:button|card|component|container|element|image|modal|panel)\s+(?:sizes?|width|height)\b/iu,
    severity: "error",
    facets: [
      facet("value", "Which value and unit?", "16px", hasUnitValue),
      facet("target", "What should the value apply to?", "the card padding", hasNamedTarget),
    ],
  },
  {
    id: "font",
    trigger: /\b(?:fonts?|typography|typefaces?)\b/iu,
    severity: "error",
    facets: [
      facet("family", "Which font family?", "Inter", hasFontFamily),
      facet("size", "Which font size?", "16px", hasFontSize),
      facet("weight", "Which font weight?", "600", hasFontWeight),
    ],
  },
  {
    id: "limit",
    trigger: /\b(?:timeouts?|retries|retry)\b|\b(?:add|apply|enforce|set)\s+(?:an?\s+|the\s+)?limits?\b|\b(?:memory|rate|request|size|token)\s+limits?\b/iu,
    severity: "error",
    facets: [
      facet("value", "Which numeric value and unit?", "a 5 second timeout, or 3 retries", (text, context) => hasUnitValue(text, context) || hasCount(text, context)),
    ],
  },
  {
    id: "subjective",
    trigger: /\b(?:make|look)\s+(?:it\s+)?(?:modern|nicer|better|prettier|cleaner|professional|beautiful)\b/iu,
    severity: "error",
    facets: [
      facet("specificChanges", "What specifically should change?", "use 16px spacing and #0A84FF buttons", (text, context) => hasUnitValue(text, context) || hasColor(text, context) || hasEnumeratedList(text, context)),
    ],
  },
];
