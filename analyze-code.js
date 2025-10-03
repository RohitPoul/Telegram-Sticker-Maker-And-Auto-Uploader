#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

console.log('🔍 Analyzing codebase for issues...\n');

// Configuration
const config = {
  rootDir: __dirname,
  jsFiles: [],
  pyFiles: [],
  issues: {
    duplicateFunctions: [],
    unusedVariables: [],
    longFunctions: [],
    complexityIssues: []
  }
};

// Find all JavaScript files
function findFiles(dir, extension) {
  const files = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    
    if (item.isDirectory() && !['node_modules', 'build', 'dist', 'reports'].includes(item.name)) {
      files.push(...findFiles(fullPath, extension));
    } else if (item.isFile() && item.name.endsWith(extension)) {
      files.push(fullPath);
    }
  }
  
  return files;
}

// Analyze JavaScript file
function analyzeJSFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const issues = [];
  
  // Find long functions (>100 lines)
  let inFunction = false;
  let functionStart = 0;
  let functionName = '';
  let braceCount = 0;
  
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    
    // Detect function start
    if (trimmed.match(/^(async\s+)?function\s+(\w+)|^(\w+)\s*\([^)]*\)\s*{|^(async\s+)?(\w+)\s*:\s*function/)) {
      if (!inFunction) {
        inFunction = true;
        functionStart = index;
        functionName = trimmed.match(/\w+/)?.[0] || 'anonymous';
        braceCount = 0;
      }
    }
    
    // Count braces
    if (inFunction) {
      braceCount += (line.match(/{/g) || []).length;
      braceCount -= (line.match(/}/g) || []).length;
      
      if (braceCount === 0 && index > functionStart) {
        const functionLength = index - functionStart;
        if (functionLength > 100) {
          issues.push({
            type: 'long-function',
            function: functionName,
            lines: functionLength,
            start: functionStart + 1,
            file: path.relative(config.rootDir, filePath)
          });
        }
        inFunction = false;
      }
    }
  });
  
  return issues;
}

// Generate report
function generateReport() {
  console.log('📊 Generating analysis report...\n');
  
  config.jsFiles = findFiles(path.join(config.rootDir, 'electron'), '.js');
  config.pyFiles = findFiles(path.join(config.rootDir, 'python'), '.py');
  
  console.log(`Found ${config.jsFiles.length} JavaScript files`);
  console.log(`Found ${config.pyFiles.length} Python files\n`);
  
  // Analyze each JS file
  config.jsFiles.forEach(file => {
    const issues = analyzeJSFile(file);
    config.issues.longFunctions.push(...issues);
  });
  
  // Create reports directory
  const reportsDir = path.join(config.rootDir, 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }
  
  // Generate markdown report
  let report = '# Code Analysis Report\n\n';
  report += `Generated: ${new Date().toLocaleString()}\n\n`;
  
  report += '## Summary\n\n';
  report += `- JavaScript files: ${config.jsFiles.length}\n`;
  report += `- Python files: ${config.pyFiles.length}\n`;
  report += `- Long functions (>100 lines): ${config.issues.longFunctions.length}\n\n`;
  
  if (config.issues.longFunctions.length > 0) {
    report += '## Long Functions (Consider Refactoring)\n\n';
    config.issues.longFunctions.forEach(issue => {
      report += `- **${issue.function}** in \`${issue.file}\` (${issue.lines} lines, starts at line ${issue.start})\n`;
    });
    report += '\n';
  }
  
  // Write report
  const reportPath = path.join(reportsDir, 'code-analysis.md');
  fs.writeFileSync(reportPath, report);
  
  console.log('✅ Analysis complete!');
  console.log(`📄 Report saved to: ${reportPath}\n`);
  
  // Print summary
  if (config.issues.longFunctions.length > 0) {
    console.log('⚠️  Issues found:');
    console.log(`   - ${config.issues.longFunctions.length} long functions that should be refactored\n`);
  } else {
    console.log('✨ No major issues found!\n');
  }
  
  console.log('💡 Next steps:');
  console.log('   1. Run `npm run lint:check` to find unused variables');
  console.log('   2. Run `npm run find-duplicates` to find duplicate code');
  console.log('   3. Run `npm run cleanup` to auto-fix issues\n');
}

// Run analysis
generateReport();
