/// <reference types="vite/client" />

// Vite `?url`-импорты возвращают строку с URL ассета.
declare module '*.wasm?url' {
  const url: string;
  export default url;
}

declare module '*.jpg?url' {
  const url: string;
  export default url;
}

declare module '*.png?url' {
  const url: string;
  export default url;
}

declare module '*.ttf?url' {
  const url: string;
  export default url;
}
