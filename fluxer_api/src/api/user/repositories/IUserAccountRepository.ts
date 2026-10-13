// SPDX-License-Identifier: AGPL-3.0-or-later

import type {types} from 'cassandra-driver';

/** Trusted service inputs, only after ownership, email, age/password and consent checks. */
export interface MigratedAccountClaimData {
	/** Revalidate server-controlled run policy after email-reservation I/O. */
	authorize?: () => Promise<void>;
	expiresAt: Date;
	email: string;
	passwordHash: string;
	dateOfBirth: types.LocalDate | null;
	termsAgreedAt: Date | null;
	privacyAgreedAt: Date | null;
}
