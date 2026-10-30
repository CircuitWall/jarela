function propertyName(property) {
  if (property.type !== "Property") return undefined;
  return property.computed
    ? property.key.value
    : property.key.name ?? property.key.value;
}

export const sharedApiErrors = {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      shared: "Use errorResponse() for plain errors or errorJson() to preserve structured fields and headers from lib/api/responses.",
    },
  },
  create(context) {
    const responseNames = new Set(["Response"]);
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "next/server") return;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier" && specifier.imported.name === "NextResponse") {
            responseNames.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier"
          || !responseNames.has(callee.object.name)
          || (callee.computed ? callee.property.value : callee.property.name) !== "json") return;
        const [body, init] = node.arguments;
        if (body?.type !== "ObjectExpression"
          || !body.properties.some((property) => propertyName(property) === "error")) return;
        const status = init?.type === "ObjectExpression"
          ? init.properties.find((property) => propertyName(property) === "status") : undefined;
        if (status?.value.type === "Literal" && typeof status.value.value === "number" && status.value.value < 400) return;
        const domainResult = body.properties.some((property) => ["ok", "status"].includes(propertyName(property)));
        if (!status && !init && domainResult) return;
        context.report({ node, messageId: "shared" });
      },
    };
  },
};

const apiResponses = { rules: { "shared-errors": sharedApiErrors } };
export default apiResponses;
