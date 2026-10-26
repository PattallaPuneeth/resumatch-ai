import type { ParsedResume, Job } from '@prisma/client';

export interface DerivedQueriesInput {
  parsedResume: ParsedResume;
  targetJob?: Job | null;
  location?: string;
  seniority?: string;
}

/**
 * Extracts a candidate's primary job title from their parsed experience or summary.
 */
function extractPrimaryTitle(parsedResume: ParsedResume): string {
  const exp = parsedResume.experience as any;
  if (Array.isArray(exp) && exp.length > 0) {
    for (const item of exp) {
      if (typeof item === 'object' && item?.title && typeof item.title === 'string') {
        const title = item.title.trim();
        if (title.length > 3) return title;
      }
    }
  }

  // Fallback to searching summary or skills
  const skills = parsedResume.skills as any;
  if (Array.isArray(skills) && skills.length > 0) {
    const firstFew = skills.slice(0, 2).map((s) => (typeof s === 'string' ? s : s?.name || '')).filter(Boolean);
    if (firstFew.length > 0) {
      return `${firstFew.join(' ')} Engineer`;
    }
  }

  return 'Software Engineer';
}

/**
 * Extracts top skill names from parsed skills.
 */
function extractTopSkills(parsedResume: ParsedResume, count: number = 3): string[] {
  const skillsData = parsedResume.skills as any;
  const list: string[] = [];

  if (Array.isArray(skillsData)) {
    for (const item of skillsData) {
      if (typeof item === 'string' && item.trim()) {
        list.push(item.trim());
      } else if (typeof item === 'object' && item?.name && typeof item.name === 'string') {
        list.push(item.name.trim());
      }
    }
  } else if (typeof skillsData === 'object' && skillsData !== null) {
    for (const val of Object.values(skillsData)) {
      if (Array.isArray(val)) {
        for (const sub of val) {
          if (typeof sub === 'string' && sub.trim()) {
            list.push(sub.trim());
          } else if (typeof sub === 'object' && sub?.name && typeof sub.name === 'string') {
            list.push(sub.name.trim());
          }
        }
      }
    }
  }

  return Array.from(new Set(list)).slice(0, count);
}

/**
 * Derives up to 3 bounded search queries based on the resume and optional target job.
 */
export function deriveJobSearchQueries(input: DerivedQueriesInput): string[] {
  const { parsedResume, targetJob, location, seniority } = input;
  const queries: string[] = [];
  const loc = (location || '').trim();
  const sen = (seniority || '').trim();

  if (targetJob) {
    // Mode B: With target JD (Similar Jobs mode)
    const jobTitle = targetJob.title.trim();
    const jobLoc = (targetJob.location || loc).trim();
    const requiredSkills: string[] = [];
    if (Array.isArray(targetJob.requiredSkills)) {
      for (const s of targetJob.requiredSkills) {
        if (typeof s === 'string' && s.trim()) requiredSkills.push(s.trim());
      }
    }

    // Query 1: Exact target title + location
    queries.push([sen, jobTitle, jobLoc].filter(Boolean).join(' '));

    // Query 2: Target title + top required skills
    if (requiredSkills.length > 0) {
      queries.push([jobTitle, requiredSkills.slice(0, 3).join(' ')].join(' '));
    } else {
      queries.push([jobTitle, 'Software Engineer', jobLoc].filter(Boolean).join(' '));
    }

    // Query 3: Target title + company domain/type or candidate top skills
    const candidateSkills = extractTopSkills(parsedResume, 2);
    if (candidateSkills.length > 0) {
      queries.push([jobTitle, candidateSkills.join(' '), jobLoc].filter(Boolean).join(' '));
    } else {
      queries.push([jobTitle, 'Developer'].join(' '));
    }
  } else {
    // Mode A: Without JD (Explore Roles mode)
    const candidateTitle = extractPrimaryTitle(parsedResume);
    const topSkills = extractTopSkills(parsedResume, 3);

    // Query 1: Seniority + Candidate Title + Location
    queries.push([sen, candidateTitle, loc].filter(Boolean).join(' '));

    // Query 2: Top Skills + Engineer + Location
    if (topSkills.length > 0) {
      queries.push([topSkills.join(' '), 'Engineer', loc].filter(Boolean).join(' '));
    } else {
      queries.push([sen, 'Software Engineer', loc].filter(Boolean).join(' '));
    }

    // Query 3: Candidate Title + Developer
    queries.push([sen, candidateTitle, 'Developer'].filter(Boolean).join(' '));
  }

  // Deduplicate and bound each query length to 100 chars, maximum 3 queries
  const cleanList = Array.from(
    new Set(
      queries
        .map((q) => q.replace(/\s+/g, ' ').trim().slice(0, 100))
        .filter((q) => q.length > 2)
    )
  );

  return cleanList.slice(0, 3);
}
