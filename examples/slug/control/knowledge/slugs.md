# Slug conventions: what a valid slug looks like and the edge cases that matter

- Lowercase ASCII letters, digits and single hyphens only.
- Punctuation is removed, not replaced: «C'est» becomes «cest», «2.0» becomes «20».
- Any run of whitespace (spaces, tabs) becomes one hyphen; leading and trailing whitespace is trimmed first.
- Non-string input is a programming error: throw TypeError.
