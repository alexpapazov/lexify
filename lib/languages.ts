export interface Language { code: string; name: string }

export const LANGUAGES: Language[] = [
  { code: 'en',  name: 'English'    },
  { code: 'es',  name: 'Spanish'    },
  { code: 'fr',  name: 'French'     },
  { code: 'de',  name: 'German'     },
  { code: 'it',  name: 'Italian'    },
  { code: 'pt',  name: 'Portuguese' },
  { code: 'nl',  name: 'Dutch'      },
  { code: 'ru',  name: 'Russian'    },
  { code: 'zh',  name: 'Chinese'    },
  { code: 'ja',  name: 'Japanese'   },
  { code: 'ko',  name: 'Korean'     },
  { code: 'ar',  name: 'Arabic'     },
  { code: 'hi',  name: 'Hindi'      },
  { code: 'tr',  name: 'Turkish'    },
  { code: 'pl',  name: 'Polish'     },
  { code: 'sv',  name: 'Swedish'    },
  { code: 'no',  name: 'Norwegian'  },
  { code: 'da',  name: 'Danish'     },
  { code: 'fi',  name: 'Finnish'    },
  { code: 'el',  name: 'Greek'      },
  { code: 'he',  name: 'Hebrew'     },
  { code: 'uk',  name: 'Ukrainian'  },
  { code: 'bg',  name: 'Bulgarian'  },
  { code: 'cs',  name: 'Czech'      },
  { code: 'hu',  name: 'Hungarian'  },
  { code: 'ro',  name: 'Romanian'   },
  { code: 'vi',  name: 'Vietnamese' },
  { code: 'th',  name: 'Thai'       },
  { code: 'id',  name: 'Indonesian' },
  { code: 'ms',  name: 'Malay'      },
  { code: 'asl', name: 'ASL'        },
  { code: 'bsl', name: 'BSL'        },
]

export function langName(code: string): string {
  return LANGUAGES.find(l => l.code === code)?.name ?? code.toUpperCase()
}
