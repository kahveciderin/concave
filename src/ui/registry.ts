export interface ResourceRegistry {
  path: string;
  fields: string[];
  capabilities?: {
    enableCreate?: boolean;
    enableUpdate?: boolean;
    enableDelete?: boolean;
    enableSubscriptions?: boolean;
    enableAggregations?: boolean;
  };
  auth?: {
    public?: { read?: boolean; subscribe?: boolean };
    hasReadScope?: boolean;
    hasCreateScope?: boolean;
    hasUpdateScope?: boolean;
    hasDeleteScope?: boolean;
  };
  procedures?: string[];
}

const registeredResources: ResourceRegistry[] = [];

export const registerResource = (resource: ResourceRegistry): void => {
  const existing = registeredResources.findIndex(r => r.path === resource.path);
  if (existing >= 0) {
    registeredResources[existing] = resource;
  } else {
    registeredResources.push(resource);
  }
};

export const unregisterResource = (path: string): void => {
  const index = registeredResources.findIndex(r => r.path === path);
  if (index >= 0) {
    registeredResources.splice(index, 1);
  }
};

export const getRegisteredResources = (): ResourceRegistry[] => {
  return [...registeredResources];
};

export const clearRegistry = (): void => {
  registeredResources.length = 0;
};
