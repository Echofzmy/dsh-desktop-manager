#import <AppKit/AppKit.h>

static NSColor *RGB(CGFloat red, CGFloat green, CGFloat blue) {
  return [NSColor colorWithCalibratedRed:red / 255.0 green:green / 255.0 blue:blue / 255.0 alpha:1.0];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *output = argc > 1 ? [NSString stringWithUTF8String:argv[1]] : @"build/icon-source/dsh-1024.png";
    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc]
      initWithBitmapDataPlanes:NULL
      pixelsWide:1024
      pixelsHigh:1024
      bitsPerSample:8
      samplesPerPixel:4
      hasAlpha:YES
      isPlanar:NO
      colorSpaceName:NSCalibratedRGBColorSpace
      bytesPerRow:0
      bitsPerPixel:0];
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap]];
    [NSColor.clearColor setFill];
    NSRectFill(NSMakeRect(0, 0, 1024, 1024));

    [RGB(65, 118, 230) setFill];
    [[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(64, 64, 896, 896) xRadius:208 yRadius:208] fill];
    [RGB(23, 25, 29) setFill];
    [[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(156, 250, 712, 524) xRadius:104 yRadius:104] fill];

    NSArray<NSColor *> *colors = @[RGB(255, 107, 97), RGB(245, 196, 81), RGB(69, 189, 118)];
    CGFloat positions[] = {250, 316, 382};
    for (NSInteger index = 0; index < 3; index++) {
      [colors[index] setFill];
      [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(positions[index] - 22, 664, 44, 44)] fill];
    }

    NSBezierPath *prompt = [NSBezierPath bezierPath];
    [prompt moveToPoint:NSMakePoint(242, 557)];
    [prompt lineToPoint:NSMakePoint(310, 499)];
    [prompt lineToPoint:NSMakePoint(242, 441)];
    prompt.lineWidth = 34;
    prompt.lineCapStyle = NSLineCapStyleRound;
    prompt.lineJoinStyle = NSLineJoinStyleRound;
    [RGB(86, 134, 254) setStroke];
    [prompt stroke];

    NSMutableParagraphStyle *paragraph = [[NSMutableParagraphStyle alloc] init];
    paragraph.alignment = NSTextAlignmentLeft;
    NSDictionary *attributes = @{
      NSFontAttributeName: [NSFont systemFontOfSize:154 weight:NSFontWeightHeavy],
      NSForegroundColorAttributeName: NSColor.whiteColor,
      NSParagraphStyleAttributeName: paragraph,
      NSKernAttributeName: @0,
    };
    [@"DSH" drawInRect:NSMakeRect(350, 420, 450, 190) withAttributes:attributes];
    [NSGraphicsContext restoreGraphicsState];

    NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    NSURL *url = [NSURL fileURLWithPath:output];
    [[NSFileManager defaultManager] createDirectoryAtURL:url.URLByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil];
    if (![png writeToURL:url options:NSDataWritingAtomic error:nil]) return 2;

    NSColor *corner = [[bitmap colorAtX:0 y:0] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
    NSColor *blue = [[bitmap colorAtX:512 y:900] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
    NSColor *center = [[bitmap colorAtX:512 y:620] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
    printf("corner=%.3f,%.3f,%.3f,%.3f blue=%.3f,%.3f,%.3f,%.3f center=%.3f,%.3f,%.3f,%.3f\n",
      corner.redComponent, corner.greenComponent, corner.blueComponent, corner.alphaComponent,
      blue.redComponent, blue.greenComponent, blue.blueComponent, blue.alphaComponent,
      center.redComponent, center.greenComponent, center.blueComponent, center.alphaComponent);
    if (corner.alphaComponent >= 0.01 || blue.blueComponent <= 0.75 || blue.alphaComponent <= 0.99 || center.redComponent >= 0.2 || center.alphaComponent <= 0.99) return 3;
    puts("Rendered deterministic 1024px DSH icon");
  }
  return 0;
}
