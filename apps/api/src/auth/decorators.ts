import { SetMetadata } from '@nestjs/common';
import { FeatureKey, Permission } from '@pos/contracts';

export const META = {
  PUBLIC: 'pos:public',
  PLATFORM_ONLY: 'pos:platformOnly',
  ALLOW_RESTRICTED: 'pos:allowRestricted',
  FEATURES: 'pos:features',
  PERMISSIONS: 'pos:permissions',
  ANY_PERMISSIONS: 'pos:anyPermissions',
};

/** No login needed. */
export const Public = () => SetMetadata(META.PUBLIC, true);
/** Super Admin only (admin subdomain). */
export const PlatformOnly = () => SetMetadata(META.PLATFORM_ONLY, true);
/** Still allowed when the subscription is restricted (read-only mode), e.g. export and payment. */
export const AllowWhenRestricted = () => SetMetadata(META.ALLOW_RESTRICTED, true);
/** All listed features must be enabled for the shop. */
export const RequireFeature = (...f: FeatureKey[]) => SetMetadata(META.FEATURES, f);
/** All listed permissions are required. */
export const RequirePermission = (...p: Permission[]) => SetMetadata(META.PERMISSIONS, p);

/** At least one of the listed permissions is required. */
export const RequireAnyPermission = (...p: Permission[]) => SetMetadata(META.ANY_PERMISSIONS, p);
