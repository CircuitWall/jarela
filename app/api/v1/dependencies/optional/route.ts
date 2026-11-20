/**
 * @public — `GET /api/v1/dependencies/optional`
 *
 * Lists the optional, on-demand packages grouped by category, with their live
 * install state, approximate size, and what keeps working without them
 * (ADR-0122). Read-only; installing is a separate explicit request.
 *
 * Query: `?category=<id>` narrows to one category.
 */
import { NextResponse } from "next/server";
import { errorJson } from "@/lib/api/responses";
import { OPTIONAL_PACKAGE_CATEGORIES, type OptionalPackageCategory } from "@/lib/dependencies/optional-catalog";
import {
  groupOptionalPackages,
  listOptionalPackageStatuses,
} from "@/lib/dependencies/optional-status";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("category")?.trim() ?? "";
  if (raw && !(OPTIONAL_PACKAGE_CATEGORIES as readonly string[]).includes(raw)) {
    return errorJson(
      { error: "unknown category", detail: `expected one of: ${OPTIONAL_PACKAGE_CATEGORIES.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const packages = await listOptionalPackageStatuses({
      category: raw ? (raw as OptionalPackageCategory) : undefined,
    });
    return NextResponse.json({
      packages,
      categories: groupOptionalPackages(packages),
    });
  } catch (err) {
    return errorJson(
      { error: "optional package lookup failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
