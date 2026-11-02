# Third-party licenses

VYRA includes or uses the following third-party material. Everything else in this project is the project's own work.

## Michroma (font), SIL Open Font License 1.1

- **What it is:** the typeface used for the **VYRA wordmark** (the wide, spaced-out "V Y R A" lettering).
- **Copyright:** Copyright 2011 The Michroma Project Authors (https://github.com/googlefonts/Michroma-font)
- **Designer:** Vernon Adams
- **Source:** https://github.com/googlefonts/Michroma-font, also published at https://fonts.google.com/specimen/Michroma
- **License:** SIL Open Font License, Version 1.1 (full text below, also at https://openfontlicense.org)
- **How it is used here:** the font file was reduced ("subset") to capital letters A to Z, the digits 0 to 9 and a few punctuation marks, converted to the WOFF format, and embedded as base64 text inside `style.css` (see the `@font-face` rule named `Michroma VYRA`). It is used only for the wordmark. No other change was made to the letterforms.
- **Reserved Font Name:** the license file for Michroma does not declare one. The font's internal name is unchanged.
- **Not sold on its own:** the font is bundled as part of this application and is not sold by itself.

### SIL Open Font License, Version 1.1 (as published with Michroma)

```text
Copyright 2011 The Michroma Project Authors (https://github.com/googlefonts/Michroma-font)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

## Fredoka (font), SIL Open Font License 1.1

- **What it is:** the rounded typeface used for normal interface text.
- **How it is used here:** **not bundled in this project.** It is loaded from Google Fonts (`fonts.googleapis.com`) when the page opens, and the app falls back to the phone's own rounded system font if it cannot be loaded.
- **License:** SIL Open Font License 1.1. Details: https://fonts.google.com/specimen/Fredoka

## ws (WebSocket library), MIT License

- **What it is:** the only runtime dependency, used by `server.js`.
- **How it is used here:** installed from npm by `npm install`; it is not copied into this repository. Its license ships inside the package.
- **Project:** https://github.com/websockets/ws
