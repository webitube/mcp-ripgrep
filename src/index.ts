#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";

/**
 * Strip ANSI escape sequences from a string to make it human-readable.
 */
function stripAnsiEscapeCodes(input: string): string {
  // This regex matches ANSI escape sequences
  return input.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Process the output based on whether colors are requested.
 * If colors are used, return the original output, otherwise strip ANSI codes.
 */
function processOutput(output: string, useColors: boolean): string {
  if (!output) return output;
  return useColors ? output : stripAnsiEscapeCodes(output);
}

// Create an MCP server
const server = new Server(
  {
    name: "ripgrep-search",
    version: "1.0.0"
  },
  {
    capabilities: {
      tools: {}  // Enable tools capability
    }
  }
);

/**
 * Execute a command with isolated streams to prevent external processes
 * from interfering with the output.
 */
function exec(program: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Use spawn with explicit stdio control (no shell needed since args are passed directly)
    const child = spawn(program, args);
    
    let stdout = "";
    let stderr = "";
    
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    
    child.on("close", (code) => {
      if (code === 0 || code === 1) { // Code 1 is "no matches" for ripgrep
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`Command failed with exit code ${code}`);
        Object.assign(error, { code, stdout, stderr });
        reject(error);
      }
    });
    
    // Handle process errors
    child.on("error", (error) => {
      reject(error);
    });
  });
}

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search",
        description: "Search files for patterns using ripgrep (rg)",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "The search pattern (regex by default)" },
            path: { type: "string", description: "Directory or file(s) to search." },
            caseSensitive: { type: "boolean", description: "Use case sensitive search (default: auto)" },
            filePattern: { type: "string", description: "Filter by file type or glob" },
            maxResults: { type: "number", description: "Limit the number of matching lines" },
            context: { type: "number", description: "Show N lines before and after each match" },
            useColors: { type: "boolean", description: "Use colors in output (default: false)" }
          },
          required: ["pattern", "path"]
        }
      },
      {
        name: "advanced-search",
        description: "Advanced search with ripgrep with more options",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "The search pattern (regex by default)" },
            path: { type: "string", description: "Directory or file(s) to search." },
            caseSensitive: { type: "boolean", description: "Use case sensitive search (default: auto)" },
            fixedStrings: { type: "boolean", description: "Treat pattern as a literal string, not a regex" },
            filePattern: { type: "string", description: "Filter by file type or glob" },
            fileType: { type: "string", description: "Filter by file type (e.g., js, py)" },
            maxResults: { type: "number", description: "Limit the number of matching lines" },
            context: { type: "number", description: "Show N lines before and after each match" },
            invertMatch: { type: "boolean", description: "Show lines that don't match the pattern" },
            wordMatch: { type: "boolean", description: "Only show matches surrounded by word boundaries" },
            includeHidden: { type: "boolean", description: "Search in hidden files and directories" },
            followSymlinks: { type: "boolean", description: "Follow symbolic links" },
            showFilenamesOnly: { type: "boolean", description: "Only show filenames of matches, not content" },
            showLineNumbers: { type: "boolean", description: "Show line numbers" },
            useColors: { type: "boolean", description: "Use colors in output (default: false)" }
          },
          required: ["pattern", "path"]
        }
      },
      {
        name: "count-matches",
        description: "Count matches in files using ripgrep",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "The search pattern (regex by default)" },
            path: { type: "string", description: "Directory or file(s) to search." },
            caseSensitive: { type: "boolean", description: "Use case sensitive search (default: auto)" },
            filePattern: { type: "string", description: "Filter by file type or glob" },
            countLines: { type: "boolean", description: "Count matching lines instead of total matches" },
            useColors: { type: "boolean", description: "Use colors in output (default: false)" }
          },
          required: ["pattern", "path"]
        }
      },
      {
        name: "list-files",
        description: "List files that would be searched by ripgrep without actually searching them",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory or file(s) to search." },
            filePattern: { type: "string", description: "Filter by file type or glob" },
            fileType: { type: "string", description: "Filter by file type (e.g., js, py)" },
            includeHidden: { type: "boolean", description: "Include hidden files and directories" }
          },
          required: ["path"]
        }
      },
      {
        name: "list-file-types",
        description: "List all supported file types in ripgrep",
        inputSchema: {
          type: "object",
          properties: {}
        }
      }
    ]
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const toolName = request.params.name;
  
  if (!["search", "advanced-search", "count-matches", "list-files", "list-file-types"].includes(toolName)) {
    // Return ServerResult.NEXT to allow the next handler to process the request
    return Object.create(null);
  }
  
  try {
    const args = request.params.arguments || {};
    
    switch (toolName) {
      case "search": {
        const pattern = String(args.pattern || "");
        const path = String(args.path);
        const caseSensitive = typeof args.caseSensitive === 'boolean' ? args.caseSensitive : undefined;
        const filePattern = args.filePattern ? String(args.filePattern) : undefined;
        const maxResults = typeof args.maxResults === 'number' ? args.maxResults : undefined;
        const context = typeof args.context === 'number' ? args.context : undefined;
        const useColors = typeof args.useColors === 'boolean' ? args.useColors : false;
        
        if (!pattern) {
          return {
            isError: true,
            content: [{ type: "text", text: "Error: Pattern is required" }]
          };
        }
        
        // Build the rg command with flags
        const rgArgs: string[] = [];
        
        // Add case sensitivity flag if specified
        if (caseSensitive === true) {
          rgArgs.push("-s"); // Case sensitive
        } else if (caseSensitive === false) {
          rgArgs.push("-i"); // Case insensitive
        }
        
        // Add file pattern if specified
        if (filePattern) {
          rgArgs.push("-g", filePattern);
        }
        
        // Add max results if specified
        if (maxResults !== undefined && maxResults > 0) {
          rgArgs.push("-m", String(maxResults));
        }
        
        // Add context lines if specified
        if (context !== undefined && context > 0) {
          rgArgs.push("-C", String(context));
        }
        
        // Add line numbers
        rgArgs.push("-n");
        
        // Add color setting
        rgArgs.push("--color", useColors ? "always" : "never");
        
        // Add pattern and path
        rgArgs.push(pattern, path);
        
        console.error(`Executing: rg ${rgArgs.join(" ")}`);
        const { stdout, stderr } = await exec("rg", rgArgs);
        
        // If there's anything in stderr, log it for debugging
        if (stderr) {
          console.error(`ripgrep stderr: ${stderr}`);
        }
        
        return {
          content: [
            {
              type: "text",
              text: processOutput(stdout, useColors) || "No matches found"
            }
          ]
        };
      }
      
      case "advanced-search": {
        const pattern = String(args.pattern || "");
        const path = String(args.path);
        const caseSensitive = typeof args.caseSensitive === 'boolean' ? args.caseSensitive : undefined;
        const fixedStrings = typeof args.fixedStrings === 'boolean' ? args.fixedStrings : undefined;
        const filePattern = args.filePattern ? String(args.filePattern) : undefined;
        const fileType = args.fileType ? String(args.fileType) : undefined;
        const maxResults = typeof args.maxResults === 'number' ? args.maxResults : undefined;
        const context = typeof args.context === 'number' ? args.context : undefined;
        const invertMatch = typeof args.invertMatch === 'boolean' ? args.invertMatch : undefined;
        const wordMatch = typeof args.wordMatch === 'boolean' ? args.wordMatch : undefined;
        const includeHidden = typeof args.includeHidden === 'boolean' ? args.includeHidden : undefined;
        const followSymlinks = typeof args.followSymlinks === 'boolean' ? args.followSymlinks : undefined;
        const showFilenamesOnly = typeof args.showFilenamesOnly === 'boolean' ? args.showFilenamesOnly : undefined;
        const showLineNumbers = typeof args.showLineNumbers === 'boolean' ? args.showLineNumbers : undefined;
        const useColors = typeof args.useColors === 'boolean' ? args.useColors : false;
        
        if (!pattern) {
          return {
            isError: true,
            content: [{ type: "text", text: "Error: Pattern is required" }]
          };
        }
        
        // Build the rg command with flags
        const rgArgs: string[] = [];
        
        // Add case sensitivity flag if specified
        if (caseSensitive === true) {
          rgArgs.push("-s"); // Case sensitive
        } else if (caseSensitive === false) {
          rgArgs.push("-i"); // Case insensitive
        }
        
        // Add fixed strings flag if specified
        if (fixedStrings === true) {
          rgArgs.push("-F"); // Fixed strings
        }
        
        // Add file pattern if specified
        if (filePattern) {
          rgArgs.push("-g", filePattern);
        }
        
        // Add file type if specified
        if (fileType) {
          rgArgs.push("-t", fileType);
        }
        
        // Add max results if specified
        if (maxResults !== undefined && maxResults > 0) {
          rgArgs.push("-m", String(maxResults));
        }
        
        // Add context lines if specified
        if (context !== undefined && context > 0) {
          rgArgs.push("-C", String(context));
        }
        
        // Add invert match if specified
        if (invertMatch === true) {
          rgArgs.push("-v");
        }
        
        // Add word match if specified
        if (wordMatch === true) {
          rgArgs.push("-w");
        }
        
        // Add hidden files flag if specified
        if (includeHidden === true) {
          rgArgs.push("-.");
        }
        
        // Add follow symlinks flag if specified
        if (followSymlinks === true) {
          rgArgs.push("-L");
        }
        
        // Add filenames only flag if specified
        if (showFilenamesOnly === true) {
          rgArgs.push("-l");
        }
        
        // Add line numbers flag if specified
        if (showLineNumbers === true) {
          rgArgs.push("-n");
        } else if (showLineNumbers === false) {
          rgArgs.push("-N");
        } else {
          // Default to showing line numbers
          rgArgs.push("-n");
        }
        
        // Add color setting
        rgArgs.push("--color", useColors ? "always" : "never");
        
        // Add pattern and path
        rgArgs.push(pattern, path);
        
        console.error(`Executing: rg ${rgArgs.join(" ")}`);
        const { stdout, stderr } = await exec("rg", rgArgs);
        
        // If there's anything in stderr, log it for debugging
        if (stderr) {
          console.error(`ripgrep stderr: ${stderr}`);
        }
        
        return {
          content: [
            {
              type: "text",
              text: processOutput(stdout, useColors) || "No matches found"
            }
          ]
        };
      }
      
       case "count-matches": {
        const pattern = String(args.pattern || "");
        const path = String(args.path);
        const caseSensitive = typeof args.caseSensitive === 'boolean' ? args.caseSensitive : undefined;
        const filePattern = args.filePattern ? String(args.filePattern) : undefined;
        const countLines = typeof args.countLines === 'boolean' ? args.countLines : true;
        const useColors = typeof args.useColors === 'boolean' ? args.useColors : false;
        
        if (!pattern) {
          return {
            isError: true,
            content: [{ type: "text", text: "Error: Pattern is required" }]
          };
        }
        
        // Build the rg command with flags
        const rgArgs: string[] = [];
        
        // Add case sensitivity flag if specified
        if (caseSensitive === true) {
          rgArgs.push("-s"); // Case sensitive
        } else if (caseSensitive === false) {
          rgArgs.push("-i"); // Case insensitive
        }
        
        // Add file pattern if specified
        if (filePattern) {
          rgArgs.push("-g", filePattern);
        }
        
        // Add count flag
        if (countLines) {
          rgArgs.push("-c"); // Count lines
        } else {
          rgArgs.push("--count-matches"); // Count total matches
        }
        
        // Add color setting
        rgArgs.push("--color", useColors ? "always" : "never");
        
        // Add pattern and path
        rgArgs.push(pattern, path);
        
        console.error(`Executing: rg ${rgArgs.join(" ")}`);
        const { stdout, stderr } = await exec("rg", rgArgs);
        
        // If there's anything in stderr, log it for debugging
        if (stderr) {
          console.error(`ripgrep stderr: ${stderr}`);
        }
        
        return {
          content: [
            {
              type: "text",
              text: processOutput(stdout, useColors) || "No matches found"
            }
          ]
        };
      }
      
      case "list-files": {
        const path = String(args.path);
        const filePattern = args.filePattern ? String(args.filePattern) : undefined;
        const fileType = args.fileType ? String(args.fileType) : undefined;
        const includeHidden = typeof args.includeHidden === 'boolean' ? args.includeHidden : undefined;
        
        // Build the rg command with flags
        const rgArgs: string[] = ["--files"];
        
        // Add file pattern if specified
        if (filePattern) {
          rgArgs.push("-g", filePattern);
        }
        
        // Add file type if specified
        if (fileType) {
          rgArgs.push("-t", fileType);
        }
        
        // Add hidden files flag if specified
        if (includeHidden === true) {
          rgArgs.push("-.");
        }
        
        // No colors for file listing
        rgArgs.push("--color", "never");
        
        // Add path
        rgArgs.push(path);
        
        console.error(`Executing: rg ${rgArgs.join(" ")}`);
        const { stdout, stderr } = await exec("rg", rgArgs);
        
        // If there's anything in stderr, log it for debugging
        if (stderr) {
          console.error(`ripgrep stderr: ${stderr}`);
        }
        
        return {
          content: [
            {
              type: "text",
              text: stripAnsiEscapeCodes(stdout) || "No files found"
            }
          ]
        };
      }
      
     case "list-file-types": {
        // No colors for type listing
        const rgArgs: string[] = ["--type-list", "--color", "never"];
        
        console.error(`Executing: rg ${rgArgs.join(" ")}`);
        const { stdout, stderr } = await exec("rg", rgArgs);
        
        // If there's anything in stderr, log it for debugging
        if (stderr) {
          console.error(`ripgrep stderr: ${stderr}`);
        }
        
        return {
          content: [
            {
              type: "text",
              text: stripAnsiEscapeCodes(stdout) || "Failed to get file types"
            }
          ]
        };
      }
      
      default:
        // This shouldn't happen due to the initial check, but TypeScript doesn't know that
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }]
        };
    }
  } catch (error: any) {
    // If the command exits with code 1, it means no matches were found for ripgrep
    if (error.code === 1 && !error.stderr) {
      return {
        content: [
          {
            type: "text",
            text: "No matches found."
          }
        ]
      };
    }
    
    // Otherwise, it's a real error
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: stripAnsiEscapeCodes(`Error: ${error.message}\n${error.stderr || ""}`)
        }
      ]
    };
  }
});

async function main() {
  // Start receiving messages on stdin and sending messages on stdout
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Ripgrep MCP Server running");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
