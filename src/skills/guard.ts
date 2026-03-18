import { scanForInjection, stripInvisibleUnicode } from "../security/injection-scanner";

export interface SkillGuardResult {
  allowed: boolean;
  threats: string[];
  sanitized?: string;
}

/** Scan skill content for injection threats and invisible unicode */
export function guardSkillContent(content: string): SkillGuardResult {
  const sanitized = stripInvisibleUnicode(content);
  const result = scanForInjection(content);

  if (!result.safe) {
    return { allowed: false, threats: result.threats };
  }

  return { allowed: true, threats: [], sanitized };
}
