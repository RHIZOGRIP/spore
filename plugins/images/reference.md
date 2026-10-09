# images — `sharp`

Your programs can import `sharp`, by name, no path: resize, crop, convert and read the size of
an image without decoding it whole. Run the program with `exec` or `wsexec` like any other.

```js
import sharp from 'sharp'
const png = await sharp({ create: { width: 4, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer()
const { width, height, format } = await sharp(png).metadata()
console.log(JSON.stringify({ width, height, format }))
```
```
{"width":4,"height":2,"format":"png"}
```

`metadata()` reads dimensions without decoding the whole image. Resize and convert chain
off the same object: `sharp(input).resize(800).jpeg({ quality: 80 }).toFile(out)`.

A cell is not given it: plugins are the root spore's alone.
