// SPDX-License-Identifier: AGPL-3.0-or-later

interface BirthDate {
	year: number;
	month: number;
	day: number;
}

function isValidBirthDate({year, month, day}: BirthDate): boolean {
	if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12)
		return false;
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
	return Number.isInteger(day) && day >= 1 && day <= daysInMonth;
}

/** Calendar date only: parsing a birthday as a UTC instant can change its day. */
export function parseDateOfBirth(value: string): BirthDate | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const [year, month, day] = value.split('-').map(Number);
	const birthDate = {year: year!, month: month!, day: day!};
	return isValidBirthDate(birthDate) ? birthDate : null;
}

export function calculateAge(
	dateOfBirth:
		| {
				year: number;
				month: number;
				day: number;
		  }
		| string,
): number {
	const today = new Date();
	const birthDate = typeof dateOfBirth === 'string' ? parseDateOfBirth(dateOfBirth) : dateOfBirth;
	if (!birthDate || !isValidBirthDate(birthDate)) return Number.NaN;
	const age = today.getFullYear() - birthDate.year;
	const monthDiff = today.getMonth() + 1 - birthDate.month;
	const dayDiff = today.getDate() - birthDate.day;
	return monthDiff < 0 || (monthDiff === 0 && dayDiff < 0) ? age - 1 : age;
}

export function isUserAdult(
	dateOfBirth?:
		| {
				year: number;
				month: number;
				day: number;
		  }
		| string
		| null,
): boolean {
	if (!dateOfBirth) return false;
	return calculateAge(dateOfBirth) >= 18;
}

interface NsfwEligibilityUser {
	isBot: boolean;
	dateOfBirth?:
		| {
				year: number;
				month: number;
				day: number;
		  }
		| string
		| null;
}

export function canUserAccessNsfwContent(user: NsfwEligibilityUser): boolean {
	if (user.isBot) {
		return true;
	}
	return isUserAdult(user.dateOfBirth);
}
