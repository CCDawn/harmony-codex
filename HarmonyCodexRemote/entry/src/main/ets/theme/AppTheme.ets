export interface AppThemeTokens {
  canvas: string;
  surface: string;
  surfaceMuted: string;
  surfaceSubtle: string;
  surfaceStrong: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textOnAccent: string;
  border: string;
  borderStrong: string;
  accent: string;
  accentSurface: string;
  accentSurfaceStrong: string;
  accentBorder: string;
  success: string;
  successSurface: string;
  danger: string;
  dangerStrong: string;
  dangerSurface: string;
  dangerBorder: string;
  warning: string;
  warningSurface: string;
  disabled: string;
  shadow: string;
  overlay: string;
}

export const DEFAULT_THEME_MODE: string = 'dark';
export const THEME_MODE_STORAGE_KEY: string = 'codexRemoteThemeMode';

const LIGHT_THEME: AppThemeTokens = {
  canvas: '#FFFFFF',
  surface: '#FFFFFF',
  surfaceMuted: '#F0F2F5',
  surfaceSubtle: '#F8F9FA',
  surfaceStrong: '#E4E7EC',
  textPrimary: '#17202A',
  textSecondary: '#65707D',
  textTertiary: '#717C89',
  textOnAccent: '#FFFFFF',
  border: '#E8EBEE',
  borderStrong: '#E6EAF0',
  accent: '#346BEA',
  accentSurface: '#EAF2FF',
  accentSurfaceStrong: '#DDEEFF',
  accentBorder: '#BBD2FF',
  success: '#14853D',
  successSurface: '#EAF8EF',
  danger: '#B42318',
  dangerStrong: '#D92D20',
  dangerSurface: '#FFF2F0',
  dangerBorder: '#F2C7C3',
  warning: '#B68A00',
  warningSurface: '#FFF8E5',
  disabled: '#D0D5DD',
  shadow: '#1F232824',
  overlay: '#00000020'
};

const NIGHT_THEME: AppThemeTokens = {
  canvas: '#080A0D',
  surface: '#11151A',
  surfaceMuted: '#171C22',
  surfaceSubtle: '#0F1318',
  surfaceStrong: '#20262E',
  textPrimary: '#F7F9FC',
  textSecondary: '#B7C0CB',
  textTertiary: '#8E99A8',
  textOnAccent: '#FFFFFF',
  border: '#2B333D',
  borderStrong: '#394350',
  accent: '#68A7FF',
  accentSurface: '#132A46',
  accentSurfaceStrong: '#183754',
  accentBorder: '#315C8F',
  success: '#4DD17B',
  successSurface: '#14301E',
  danger: '#FF8A80',
  dangerStrong: '#FF6B61',
  dangerSurface: '#321716',
  dangerBorder: '#6E302C',
  warning: '#F3C85B',
  warningSurface: '#302713',
  disabled: '#5E6875',
  shadow: '#00000080',
  overlay: '#00000099'
};

export function normalizeThemeMode(value: string): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'light' || normalized === 'system') {
    return normalized;
  }
  return DEFAULT_THEME_MODE;
}

export function themeModeLabel(value: string): string {
  const normalized = normalizeThemeMode(value);
  if (normalized === 'light') {
    return '浅色';
  }
  if (normalized === 'system') {
    return '跟随系统';
  }
  return '夜晚';
}

export function appThemeTokens(dark: boolean): AppThemeTokens {
  return dark ? NIGHT_THEME : LIGHT_THEME;
}

export function resolveThemeColor(lightColor: string, dark: boolean): string {
  if (!dark) {
    return lightColor;
  }
  const tokens = NIGHT_THEME;
  switch (String(lightColor ?? '').toUpperCase()) {
    case '#FFFFFF':
      return tokens.surface;
    case '#F7F8FA':
      return tokens.canvas;
    case '#F0F2F5':
    case '#F2F4F7':
    case '#ECEFF3':
    case '#E4E7EC':
    case '#E5EAF0':
      return tokens.surfaceMuted;
    case '#F8FAFC':
    case '#F9FAFB':
      return tokens.surfaceSubtle;
    case '#F0ECE9':
      return tokens.surfaceStrong;
    case '#17202A':
    case '#22272E':
    case '#1F2937':
    case '#344054':
    case '#101828':
    case '#132235':
      return tokens.textPrimary;
    case '#68717D':
    case '#667085':
    case '#52606D':
    case '#475467':
    case '#4E6278':
    case '#426384':
      return tokens.textSecondary;
    case '#8A95A3':
    case '#8A949F':
    case '#98A2B3':
    case '#A0A6AD':
    case '#A0A8B2':
      return tokens.textTertiary;
    case '#DDE3EA':
    case '#D0D5DD':
      return tokens.border;
    case '#E6EAF0':
      return tokens.borderStrong;
    case '#1F6FEB':
    case '#175CD3':
    case '#2F6FBE':
      return tokens.accent;
    case '#EAF2FF':
    case '#EAF4FF':
    case '#E8F0FE':
      return tokens.accentSurface;
    case '#DDEEFF':
    case '#CFE3FF':
      return tokens.accentSurfaceStrong;
    case '#BBD2FF':
    case '#C2DAF8':
    case '#DDEBFF':
      return tokens.accentBorder;
    case '#14853D':
    case '#137333':
      return tokens.success;
    case '#EAF8EF':
      return tokens.successSurface;
    case '#B42318':
      return tokens.danger;
    case '#D92D20':
      return tokens.dangerStrong;
    case '#FFF2F0':
    case '#FFF1F0':
    case '#FFF4F2':
      return tokens.dangerSurface;
    case '#F2C7C3':
    case '#FDA29B':
      return tokens.dangerBorder;
    case '#B68A00':
    case '#A15C00':
    case '#9A6700':
    case '#7A4D00':
    case '#7A4E00':
    case '#B54708':
      return tokens.warning;
    case '#FFF8E5':
    case '#FFF8E1':
    case '#FFF8D8':
    case '#FFF4E5':
      return tokens.warningSurface;
    case '#1F232824':
    case '#1F232820':
    case '#1F232812':
      return tokens.shadow;
    case '#00000020':
      return tokens.overlay;
    case '#1F2328':
      return tokens.surfaceStrong;
    case '#111111':
      return '#050607';
    default:
      return lightColor;
  }
}
