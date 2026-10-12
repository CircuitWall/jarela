import type { BuiltinCategory } from "../../runtime/registry";
import type { RegisteredPackage } from "../langchain-package";

export interface DefaultPackageDescriptor {
  id: string;
  label: string;
  category: BuiltinCategory;
  integrationId: string;
  npmPackage: string;
  toolCounts: { read: number; write: number; execute: number };
  description: string;
  register: () => RegisteredPackage<unknown>;
}

export interface DefaultPackageInfo {
  id: string;
  label: string;
  category: BuiltinCategory;
  integrationId: string;
  npmPackage: string;
  toolCounts: { read: number; write: number; execute: number };
  description: string;
  enabled: boolean;
  installed: boolean;
}